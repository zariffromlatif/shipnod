import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { PlanId } from '../billing/plans.js';
import type { SmsLanguage } from '../confirmation/messages.js';
import type {
  CourierId,
  DeliveryHistory,
  RiskLevel,
  DeliveryOutcome,
  Order,
  OrderItem,
  OrderSource,
  OrderStatus,
  RiskAssessment,
} from '../domain/types.js';
import type { RiskPolicy } from '../risk/score.js';
import { MIGRATIONS } from './migrations.js';

export interface Seller {
  id: string;
  name: string;
  shopName: string;
  phone: string | null;
  plan: PlanId;
  smsLang: SmsLanguage;
  /** Delivery charge asked in advance from high-risk customers. */
  advanceFeeBdt: number;
  bkashNumber: string | null;
  /** Custom thresholds (Growth+). null = defaults. */
  riskPolicy: RiskPolicy | null;
  /** When set, low-risk orders are booked with this courier automatically. */
  autoBookCourier: CourierId | null;
  /** Shared secret for WooCommerce / Shopify webhook signatures. */
  webhookSecret: string;
  /** Seller's own estimate of what one failed COD delivery costs them; drives the "money saved" metric. */
  costPerFailedOrderBdt: number;
  createdAt: string;
}

export type NewSeller = Omit<Seller, 'createdAt'> & { apiKeyHash: string };
export type SellerPatch = Partial<Omit<Seller, 'id' | 'createdAt'>>;

export interface StoredOrder extends Order {
  phoneHash: string | null;
}

export interface OrderListOptions {
  /** Single status (kept for the API); ignored when `statuses` is given. */
  status?: OrderStatus;
  statuses?: readonly OrderStatus[];
  level?: RiskLevel;
  /** Matches phone, customer name or order id. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LoginCodeRow {
  id: number;
  sellerId: string;
  codeHash: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type OrderPatch = Partial<
  Pick<
    StoredOrder,
    | 'status'
    | 'risk'
    | 'confirmCode'
    | 'confirmExpiresAt'
    | 'courier'
    | 'consignmentId'
    | 'trackingCode'
    | 'address'
    | 'customerName'
  >
>;

export interface UsageRow {
  orders: number;
  riskChecks: number;
  smsSent: number;
  smsSegments: number;
}

type Row = Record<string, unknown>;

const SELLER_COLUMNS: Record<keyof SellerPatch, string> = {
  name: 'name',
  shopName: 'shop_name',
  phone: 'phone',
  plan: 'plan',
  smsLang: 'sms_lang',
  advanceFeeBdt: 'advance_fee_bdt',
  bkashNumber: 'bkash_number',
  riskPolicy: 'risk_policy_json',
  autoBookCourier: 'auto_book_courier',
  webhookSecret: 'webhook_secret',
  costPerFailedOrderBdt: 'cost_per_failed_order_bdt',
};

const ORDER_COLUMNS: Record<keyof OrderPatch, string> = {
  status: 'status',
  risk: 'risk_json',
  confirmCode: 'confirm_code',
  confirmExpiresAt: 'confirm_expires_at',
  courier: 'courier',
  consignmentId: 'consignment_id',
  trackingCode: 'tracking_code',
  address: 'address',
  customerName: 'customer_name',
};

function str(v: unknown): string {
  return String(v);
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
function json<T>(v: unknown): T | null {
  return v == null ? null : (JSON.parse(String(v)) as T);
}

function sellerFromRow(r: Row): Seller {
  return {
    id: str(r.id),
    name: str(r.name),
    shopName: str(r.shop_name),
    phone: strOrNull(r.phone),
    plan: str(r.plan) as PlanId,
    smsLang: str(r.sms_lang) as SmsLanguage,
    advanceFeeBdt: Number(r.advance_fee_bdt),
    bkashNumber: strOrNull(r.bkash_number),
    riskPolicy: json<RiskPolicy>(r.risk_policy_json),
    autoBookCourier: strOrNull(r.auto_book_courier) as CourierId | null,
    webhookSecret: str(r.webhook_secret),
    costPerFailedOrderBdt: Number(r.cost_per_failed_order_bdt),
    createdAt: str(r.created_at),
  };
}

function orderFromRow(r: Row): StoredOrder {
  return {
    id: str(r.id),
    sellerId: str(r.seller_id),
    externalId: strOrNull(r.external_id),
    source: str(r.source) as OrderSource,
    customerName: str(r.customer_name),
    phone: str(r.phone),
    phoneValid: Number(r.phone_valid) === 1,
    phoneHash: strOrNull(r.phone_hash),
    address: str(r.address),
    district: strOrNull(r.district),
    codAmount: Number(r.cod_amount),
    items: json<OrderItem[]>(r.items_json) ?? [],
    note: strOrNull(r.note),
    status: str(r.status) as OrderStatus,
    risk: json<RiskAssessment>(r.risk_json),
    confirmCode: strOrNull(r.confirm_code),
    confirmExpiresAt: strOrNull(r.confirm_expires_at),
    courier: strOrNull(r.courier) as CourierId | null,
    consignmentId: strOrNull(r.consignment_id),
    trackingCode: strOrNull(r.tracking_code),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as SQLInputValue;
}

function emptyHistory(): DeliveryHistory {
  return { delivered: 0, returned: 0, cancelled: 0 };
}

/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native build step, one file on a VPS).
 * Comfortable for the first few hundred sellers; the Store surface is small on purpose so a
 * Postgres implementation can replace it later (see docs/04-architecture.md).
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    const current = Number(row.user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- sellers

  createSeller(s: NewSeller): Seller {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sellers (id, name, shop_name, phone, api_key_hash, plan, sms_lang, advance_fee_bdt, bkash_number,
           risk_policy_json, auto_book_courier, webhook_secret, cost_per_failed_order_bdt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.name,
        s.shopName,
        s.phone,
        s.apiKeyHash,
        s.plan,
        s.smsLang,
        s.advanceFeeBdt,
        s.bkashNumber,
        toSql(s.riskPolicy),
        s.autoBookCourier,
        s.webhookSecret,
        s.costPerFailedOrderBdt,
        createdAt,
      );
    return this.getSeller(s.id)!;
  }

  getSeller(id: string): Seller | null {
    const r = this.db.prepare('SELECT * FROM sellers WHERE id = ?').get(id) as Row | undefined;
    return r ? sellerFromRow(r) : null;
  }

  getSellerByPhone(phone: string): Seller | null {
    const r = this.db.prepare('SELECT * FROM sellers WHERE phone = ?').get(phone) as Row | undefined;
    return r ? sellerFromRow(r) : null;
  }

  getSellerByApiKeyHash(hash: string): Seller | null {
    const r = this.db.prepare('SELECT * FROM sellers WHERE api_key_hash = ?').get(hash) as Row | undefined;
    return r ? sellerFromRow(r) : null;
  }

  updateSeller(id: string, patch: SellerPatch): Seller {
    const entries = Object.entries(patch).filter(([k]) => k in SELLER_COLUMNS) as Array<[keyof SellerPatch, unknown]>;
    if (entries.length > 0) {
      const sets = entries.map(([k]) => `${SELLER_COLUMNS[k]} = ?`).join(', ');
      this.db.prepare(`UPDATE sellers SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => toSql(v)), id);
    }
    const seller = this.getSeller(id);
    if (!seller) throw new Error(`Seller ${id} not found`);
    return seller;
  }

  // ----------------------------------------------------------------- orders

  insertOrder(o: StoredOrder): StoredOrder {
    this.db
      .prepare(
        `INSERT INTO orders (id, seller_id, external_id, source, customer_name, phone, phone_valid, phone_hash, address,
           district, cod_amount, items_json, note, status, risk_json, risk_score, confirm_code, confirm_expires_at,
           courier, consignment_id, tracking_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.sellerId,
        o.externalId,
        o.source,
        o.customerName,
        o.phone,
        o.phoneValid ? 1 : 0,
        o.phoneHash,
        o.address,
        o.district,
        o.codAmount,
        JSON.stringify(o.items),
        o.note,
        o.status,
        toSql(o.risk),
        o.risk?.score ?? null,
        o.confirmCode,
        o.confirmExpiresAt,
        o.courier,
        o.consignmentId,
        o.trackingCode,
        o.createdAt,
        o.updatedAt,
      );
    return o;
  }

  getOrder(id: string): StoredOrder | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return r ? orderFromRow(r) : null;
  }

  getSellerOrder(sellerId: string, id: string): StoredOrder | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ? AND seller_id = ?').get(id, sellerId) as Row | undefined;
    return r ? orderFromRow(r) : null;
  }

  getOrderByConfirmCode(code: string): StoredOrder | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE confirm_code = ?').get(code) as Row | undefined;
    return r ? orderFromRow(r) : null;
  }

  findOrderByExternalId(sellerId: string, source: OrderSource, externalId: string): StoredOrder | null {
    const r = this.db
      .prepare('SELECT * FROM orders WHERE seller_id = ? AND source = ? AND external_id = ?')
      .get(sellerId, source, externalId) as Row | undefined;
    return r ? orderFromRow(r) : null;
  }

  listOrders(sellerId: string, opts: OrderListOptions = {}): StoredOrder[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = ['seller_id = ?'];
    const params: SQLInputValue[] = [sellerId];
    const statuses = opts.statuses ?? (opts.status ? [opts.status] : []);
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (opts.level) {
      where.push(`json_extract(risk_json, '$.level') = ?`);
      params.push(opts.level);
    }
    if (opts.search) {
      const like = `%${opts.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`(phone LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return (rows as Row[]).map(orderFromRow);
  }

  /** Orders with a courier whose final outcome is not known yet. */
  listShippedOrders(limit = 200): StoredOrder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders WHERE status IN ('booked', 'in_transit') AND courier IS NOT NULL
         AND consignment_id IS NOT NULL ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(orderFromRow);
  }

  updateOrder(id: string, patch: OrderPatch): StoredOrder {
    const entries = Object.entries(patch).filter(([k]) => k in ORDER_COLUMNS) as Array<[keyof OrderPatch, unknown]>;
    const sets = entries.map(([k]) => `${ORDER_COLUMNS[k]} = ?`);
    const values = entries.map(([, v]) => toSql(v));
    if (patch.risk !== undefined) {
      sets.push('risk_score = ?');
      values.push(patch.risk?.score ?? null);
    }
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    this.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const order = this.getOrder(id);
    if (!order) throw new Error(`Order ${id} not found`);
    return order;
  }

  addOrderEvent(e: { orderId: string; from: OrderStatus | null; to: OrderStatus; actor: string; detail?: string }): void {
    this.db
      .prepare('INSERT INTO order_events (order_id, from_status, to_status, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.orderId, e.from, e.to, e.actor, e.detail ?? null, new Date().toISOString());
  }

  listOrderEvents(orderId: string): Array<{ from: string | null; to: string; actor: string; detail: string | null; at: string }> {
    const rows = this.db
      .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC')
      .all(orderId) as Row[];
    return rows.map((r) => ({
      from: strOrNull(r.from_status),
      to: str(r.to_status),
      actor: str(r.actor),
      detail: strOrNull(r.detail),
      at: str(r.created_at),
    }));
  }

  /** Average COD value over the last 90 days; null until there are at least 10 orders. */
  sellerAverageOrderValue(sellerId: string): number | null {
    const since = new Date(Date.now() - 90 * 86400_000).toISOString();
    const r = this.db
      .prepare('SELECT COUNT(*) AS n, AVG(cod_amount) AS avg FROM orders WHERE seller_id = ? AND cod_amount > 0 AND created_at >= ?')
      .get(sellerId, since) as Row;
    return Number(r.n) >= 10 ? Number(r.avg) : null;
  }

  countOrdersByStatus(sellerId: string, sinceIso?: string): Record<string, number> {
    const rows = (
      sinceIso
        ? this.db
            .prepare('SELECT status, COUNT(*) AS n FROM orders WHERE seller_id = ? AND created_at >= ? GROUP BY status')
            .all(sellerId, sinceIso)
        : this.db.prepare('SELECT status, COUNT(*) AS n FROM orders WHERE seller_id = ? GROUP BY status').all(sellerId)
    ) as Row[];
    return Object.fromEntries(rows.map((r) => [str(r.status), Number(r.n)]));
  }

  // ---------------------------------------------------------------- network

  recordOutcome(e: { orderId: string; phoneHash: string; sellerId: string; outcome: DeliveryOutcome }): void {
    this.db
      .prepare(
        `INSERT INTO network_outcomes (order_id, phone_hash, seller_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (order_id) DO UPDATE SET outcome = excluded.outcome, created_at = excluded.created_at`,
      )
      .run(e.orderId, e.phoneHash, e.sellerId, e.outcome, new Date().toISOString());
  }

  private history(sql: string, ...params: SQLInputValue[]): DeliveryHistory {
    const h = emptyHistory();
    for (const r of this.db.prepare(sql).all(...params) as Row[]) {
      const outcome = str(r.outcome) as DeliveryOutcome;
      h[outcome] = Number(r.n);
    }
    return h;
  }

  networkHistory(phoneHash: string): DeliveryHistory {
    return this.history('SELECT outcome, COUNT(*) AS n FROM network_outcomes WHERE phone_hash = ? GROUP BY outcome', phoneHash);
  }

  sellerHistory(phoneHash: string, sellerId: string): DeliveryHistory {
    return this.history(
      'SELECT outcome, COUNT(*) AS n FROM network_outcomes WHERE phone_hash = ? AND seller_id = ? GROUP BY outcome',
      phoneHash,
      sellerId,
    );
  }

  returnSellerCount(phoneHash: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(DISTINCT seller_id) AS n FROM network_outcomes WHERE phone_hash = ? AND outcome = 'returned'`)
      .get(phoneHash) as Row;
    return Number(r.n);
  }

  recentOrderCount(phoneHash: string, sinceIso: string, excludeOrderId?: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE phone_hash = ? AND created_at >= ? AND id != ?')
      .get(phoneHash, sinceIso, excludeOrderId ?? '') as Row;
    return Number(r.n);
  }

  // -------------------------------------------------------------- blocklist

  block(sellerId: string, phoneHash: string, reason: string | null, phoneMasked: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO blocklist (seller_id, phone_hash, reason, created_at, phone_masked) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (seller_id, phone_hash) DO UPDATE SET reason = excluded.reason,
           phone_masked = COALESCE(excluded.phone_masked, phone_masked)`,
      )
      .run(sellerId, phoneHash, reason, new Date().toISOString(), phoneMasked);
  }

  listBlocklist(sellerId: string): Array<{ phoneHash: string; phoneMasked: string | null; reason: string | null; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM blocklist WHERE seller_id = ? ORDER BY created_at DESC')
      .all(sellerId) as Row[];
    return rows.map((r) => ({
      phoneHash: str(r.phone_hash),
      phoneMasked: strOrNull(r.phone_masked),
      reason: strOrNull(r.reason),
      createdAt: str(r.created_at),
    }));
  }

  unblock(sellerId: string, phoneHash: string): boolean {
    return Number(this.db.prepare('DELETE FROM blocklist WHERE seller_id = ? AND phone_hash = ?').run(sellerId, phoneHash).changes) > 0;
  }

  isBlocked(sellerId: string, phoneHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM blocklist WHERE seller_id = ? AND phone_hash = ?').get(sellerId, phoneHash) !== undefined;
  }

  // ------------------------------------------------------------------ usage

  incrementUsage(sellerId: string, period: string, delta: Partial<UsageRow>): void {
    this.db
      .prepare(
        `INSERT INTO usage (seller_id, period, orders, risk_checks, sms_sent, sms_segments) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (seller_id, period) DO UPDATE SET
           orders = orders + excluded.orders,
           risk_checks = risk_checks + excluded.risk_checks,
           sms_sent = sms_sent + excluded.sms_sent,
           sms_segments = sms_segments + excluded.sms_segments`,
      )
      .run(sellerId, period, delta.orders ?? 0, delta.riskChecks ?? 0, delta.smsSent ?? 0, delta.smsSegments ?? 0);
  }

  getUsage(sellerId: string, period: string): UsageRow {
    const r = this.db.prepare('SELECT * FROM usage WHERE seller_id = ? AND period = ?').get(sellerId, period) as Row | undefined;
    return {
      orders: Number(r?.orders ?? 0),
      riskChecks: Number(r?.risk_checks ?? 0),
      smsSent: Number(r?.sms_sent ?? 0),
      smsSegments: Number(r?.sms_segments ?? 0),
    };
  }

  // --------------------------------------------------------------- couriers

  saveCourierAccount(sellerId: string, courier: CourierId, credentialsSealed: string): void {
    this.db
      .prepare(
        `INSERT INTO courier_accounts (seller_id, courier, credentials_sealed, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (seller_id, courier) DO UPDATE SET credentials_sealed = excluded.credentials_sealed`,
      )
      .run(sellerId, courier, credentialsSealed, new Date().toISOString());
  }

  getCourierAccount(sellerId: string, courier: CourierId): string | null {
    const r = this.db
      .prepare('SELECT credentials_sealed FROM courier_accounts WHERE seller_id = ? AND courier = ?')
      .get(sellerId, courier) as Row | undefined;
    return r ? str(r.credentials_sealed) : null;
  }

  listCourierAccounts(sellerId: string): CourierId[] {
    const rows = this.db.prepare('SELECT courier FROM courier_accounts WHERE seller_id = ? ORDER BY courier').all(sellerId) as Row[];
    return rows.map((r) => str(r.courier) as CourierId);
  }

  // -------------------------------------------------------------------- sms

  logSms(e: {
    sellerId: string;
    orderId: string | null;
    to: string;
    text: string;
    segments: number;
    ok: boolean;
    providerMessageId?: string;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sms_log (seller_id, order_id, to_phone, text, segments, ok, provider_message_id, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.sellerId, e.orderId, e.to, e.text, e.segments, e.ok ? 1 : 0, e.providerMessageId ?? null, e.error ?? null, new Date().toISOString());
  }

  // --------------------------------------------------------------- sessions

  createSession(tokenHash: string, sellerId: string, createdAt: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, seller_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, sellerId, createdAt, expiresAt);
  }

  getSessionSellerId(tokenHash: string, nowIso: string): string | null {
    const r = this.db
      .prepare('SELECT seller_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, nowIso) as Row | undefined;
    return r ? str(r.seller_id) : null;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(nowIso: string): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso).changes);
  }

  // ------------------------------------------------------------ login codes

  createLoginCode(e: { sellerId: string; codeHash: string; createdAt: string; expiresAt: string }): void {
    this.db
      .prepare('INSERT INTO login_codes (seller_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(e.sellerId, e.codeHash, e.createdAt, e.expiresAt);
  }

  latestLoginCode(sellerId: string): LoginCodeRow | null {
    const r = this.db
      .prepare('SELECT * FROM login_codes WHERE seller_id = ? ORDER BY id DESC LIMIT 1')
      .get(sellerId) as Row | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      sellerId: str(r.seller_id),
      codeHash: str(r.code_hash),
      attempts: Number(r.attempts),
      createdAt: str(r.created_at),
      expiresAt: str(r.expires_at),
      usedAt: strOrNull(r.used_at),
    };
  }

  countLoginCodesSince(sellerId: string, sinceIso: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM login_codes WHERE seller_id = ? AND created_at >= ?')
      .get(sellerId, sinceIso) as Row;
    return Number(r.n);
  }

  recordLoginAttempt(id: number): void {
    this.db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
  }

  markLoginCodeUsed(id: number, usedAt: string): void {
    this.db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').run(usedAt, id);
  }
}
