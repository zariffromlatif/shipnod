/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Append new migrations; never edit one that has shipped.
 *
 * Privacy model: `orders.phone` is the seller's own customer data (needed to ship). The shared
 * cross-seller network (`network_outcomes`, `blocklist`, burst detection) only ever sees
 * `phone_hash` = HMAC-SHA256(NETWORK_HASH_SECRET, phone).
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sellers (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL,
    shop_name                 TEXT NOT NULL,
    phone                     TEXT,
    api_key_hash              TEXT NOT NULL UNIQUE,
    plan                      TEXT NOT NULL DEFAULT 'free',
    sms_lang                  TEXT NOT NULL DEFAULT 'bn',
    advance_fee_bdt           INTEGER NOT NULL DEFAULT 130,
    bkash_number              TEXT,
    risk_policy_json          TEXT,
    auto_book_courier         TEXT,
    webhook_secret            TEXT NOT NULL,
    cost_per_failed_order_bdt INTEGER NOT NULL DEFAULT 150,
    created_at                TEXT NOT NULL
  );

  CREATE TABLE orders (
    id                 TEXT PRIMARY KEY,
    seller_id          TEXT NOT NULL REFERENCES sellers(id),
    external_id        TEXT,
    source             TEXT NOT NULL,
    customer_name      TEXT NOT NULL,
    phone              TEXT NOT NULL,
    phone_valid        INTEGER NOT NULL,
    phone_hash         TEXT,
    address            TEXT NOT NULL,
    district           TEXT,
    cod_amount         REAL NOT NULL,
    items_json         TEXT NOT NULL,
    note               TEXT,
    status             TEXT NOT NULL,
    risk_json          TEXT,
    risk_score         INTEGER,
    confirm_code       TEXT UNIQUE,
    confirm_expires_at TEXT,
    courier            TEXT,
    consignment_id     TEXT,
    tracking_code      TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (seller_id, source, external_id)
  );
  CREATE INDEX orders_seller_status ON orders (seller_id, status, created_at);
  CREATE INDEX orders_phone_hash_created ON orders (phone_hash, created_at);

  CREATE TABLE order_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT NOT NULL REFERENCES orders(id),
    from_status TEXT,
    to_status   TEXT NOT NULL,
    actor       TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX order_events_order ON order_events (order_id, id);

  CREATE TABLE network_outcomes (
    order_id   TEXT PRIMARY KEY REFERENCES orders(id),
    phone_hash TEXT NOT NULL,
    seller_id  TEXT NOT NULL,
    outcome    TEXT NOT NULL CHECK (outcome IN ('delivered', 'returned', 'cancelled')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX network_outcomes_phone ON network_outcomes (phone_hash, outcome);

  CREATE TABLE blocklist (
    seller_id  TEXT NOT NULL REFERENCES sellers(id),
    phone_hash TEXT NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (seller_id, phone_hash)
  );

  CREATE TABLE usage (
    seller_id    TEXT NOT NULL REFERENCES sellers(id),
    period       TEXT NOT NULL,
    orders       INTEGER NOT NULL DEFAULT 0,
    risk_checks  INTEGER NOT NULL DEFAULT 0,
    sms_sent     INTEGER NOT NULL DEFAULT 0,
    sms_segments INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (seller_id, period)
  );

  CREATE TABLE courier_accounts (
    seller_id          TEXT NOT NULL REFERENCES sellers(id),
    courier            TEXT NOT NULL,
    credentials_sealed TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    PRIMARY KEY (seller_id, courier)
  );

  CREATE TABLE sms_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id           TEXT NOT NULL,
    order_id            TEXT,
    to_phone            TEXT NOT NULL,
    text                TEXT NOT NULL,
    segments            INTEGER NOT NULL,
    ok                  INTEGER NOT NULL,
    provider_message_id TEXT,
    error               TEXT,
    created_at          TEXT NOT NULL
  );
  `,
  // 2: seller dashboard — phone OTP login, sessions, readable blocklist entries.
  `
  CREATE UNIQUE INDEX sellers_phone_unique ON sellers (phone) WHERE phone IS NOT NULL;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    seller_id  TEXT NOT NULL REFERENCES sellers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_seller ON sessions (seller_id);

  CREATE TABLE login_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id  TEXT NOT NULL REFERENCES sellers(id),
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX login_codes_seller ON login_codes (seller_id, created_at);

  -- Masked form ("017****5678") so sellers can recognise blocked numbers; the hash stays the key.
  ALTER TABLE blocklist ADD COLUMN phone_masked TEXT;
  `,
  // 3: billing — prepaid subscriptions, invoices, payments (SSLCommerz + manual bKash/Nagad), admin sessions.
  `
  -- plan_paid_until NULL = no expiry (comped account or pilot granted by an admin).
  ALTER TABLE sellers ADD COLUMN plan_cycle TEXT;
  ALTER TABLE sellers ADD COLUMN plan_paid_until TEXT;
  ALTER TABLE sellers ADD COLUMN plan_daily_rate REAL NOT NULL DEFAULT 0;
  ALTER TABLE sellers ADD COLUMN credit_bdt INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sellers ADD COLUMN billing_reminder TEXT;

  -- Overage is recorded when it happens (against the plan active at that moment), billed on the next invoice.
  ALTER TABLE usage ADD COLUMN overage_orders INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usage ADD COLUMN overage_invoice_id TEXT;

  CREATE TABLE invoices (
    id                  TEXT PRIMARY KEY,
    number              TEXT NOT NULL UNIQUE,
    seller_id           TEXT NOT NULL REFERENCES sellers(id),
    status              TEXT NOT NULL CHECK (status IN ('open', 'paid', 'void')),
    plan                TEXT NOT NULL,
    cycle               TEXT NOT NULL CHECK (cycle IN ('monthly', 'annual')),
    lines_json          TEXT NOT NULL,
    subtotal_bdt        INTEGER NOT NULL,
    proration_credit_bdt INTEGER NOT NULL,
    balance_credit_bdt  INTEGER NOT NULL,
    credit_applied_bdt  INTEGER NOT NULL,
    total_bdt           INTEGER NOT NULL,
    created_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    paid_at             TEXT,
    payment_method      TEXT
  );
  CREATE INDEX invoices_seller ON invoices (seller_id, created_at);

  CREATE TABLE payments (
    id          TEXT PRIMARY KEY,
    invoice_id  TEXT NOT NULL REFERENCES invoices(id),
    seller_id   TEXT NOT NULL REFERENCES sellers(id),
    method      TEXT NOT NULL CHECK (method IN ('sslcommerz', 'bkash', 'nagad', 'credit')),
    status      TEXT NOT NULL CHECK (status IN ('initiated', 'pending_review', 'succeeded', 'failed', 'rejected')),
    amount_bdt  INTEGER NOT NULL,
    reference   TEXT,
    payer_phone TEXT,
    detail      TEXT,
    raw_json    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  -- A bKash/Nagad TrxID (or gateway bank transaction) can only ever pay once.
  CREATE UNIQUE INDEX payments_reference ON payments (method, reference) WHERE reference IS NOT NULL AND status != 'rejected';
  CREATE INDEX payments_status ON payments (status, created_at);
  CREATE INDEX payments_invoice ON payments (invoice_id);

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
];
