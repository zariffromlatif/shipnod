# 04 — Architecture

## Goals that shape the design

1. **One person can run it.** A single Node process on a ~$10–20/month VPS, one SQLite file, no queue, no Redis, no native build steps.
2. **Every decision is explainable.** Sellers act on the score only if they can see why. Disputes ("why was my customer asked for an advance?") are answered from the event log.
3. **The network is the moat, and it must be privacy-safe.** Cross-seller data is keyed by HMAC'd phone numbers only.
4. **The pieces can be swapped later.** Couriers, SMS gateways and storage sit behind small interfaces.

## Components

```
src/
  domain/         phone normalisation (incl. Bangla digits), order types, state machine
  risk/           explainable additive risk score + policy → level → action
  confirmation/   SMS copy (bn / banglish / en, segment counting) and SMS providers
  couriers/       CourierAdapter interface; Steadfast, Pathao, RedX; credential schemas
  integrations/   WooCommerce and Shopify webhook payload mapping + signature checks
  billing/        plans, limits, overage, billing period (Asia/Dhaka)
  db/             node:sqlite Store + migrations
  services/       ShipnodService: the order pipeline (the only place business rules live)
  http/           Hono app: seller API, webhooks, customer confirmation pages
  http/dashboard/ server-rendered seller dashboard (/app): views, routes, UI kit
  server.ts       process entry: HTTP server + courier status-sync timer
```

The HTTP layer validates input (zod) and maps errors. All rules (plan limits, transitions, when to send SMS, when to record network outcomes) live in `ShipnodService`, so the API, the dashboard and a future CSV importer or Chrome extension all run the same pipeline.

## Seller dashboard

The dashboard is server-rendered by the same process, with no client-side framework and no build step. Pages are plain HTML forms, so they work on cheap Android phones and slow connections.

- **Rendering:** templates use `hono/html`, which escapes every interpolated value. Customer-supplied text (names, addresses, notes) cannot inject markup, and a test checks this. `raw()` is used only for constant strings.
- **Login:** phone number plus a 6-digit SMS code, the same flow sellers know from bKash and bank apps. Codes are stored hashed, expire after 10 minutes, and can be used once. Each code allows 5 wrong guesses. A seller can request at most one code per 60 seconds and 5 per hour. An unregistered number gets the same screen as a registered one, so the login page can't be used to find out which numbers are sellers. Logging in with an API key is the fallback.
- **Sessions:** a random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie (also `Secure` in production), scoped to `/app` and kept for 30 days. Only its SHA-256 hash is stored.
- **CSRF:** every form carries a token derived from the session token, checked in constant time on every POST, on top of `SameSite=Lax`.
- **Isolation:** every order lookup is scoped to the logged-in seller. Another seller's order id returns 404.
- **Blocklist display:** blocked numbers are stored as an HMAC plus a masked form (`013****8888`), so sellers can recognise them without the raw number being kept.
- **Visual rules:** the status colours (green, amber, orange, red) are reserved for risk levels, and each level also has its own glyph and text label, so colour never carries meaning alone. There is one large headline figure per page. Light and dark mode follow the device setting.

## Billing

- **Model:** prepaid periods (30 or 365 days). Bangladeshi wallets can't be charged automatically. The *effective* plan (`subscriptionState`) drives every limit: Growth that expired more than 3 days ago behaves like Free, while the purchased plan is remembered for renewal.
- **Flow:** quote → invoice (one open per seller, 24 h) → payment → `settle()`. Settling runs in one transaction. It activates the plan, stacks a same-plan renewal onto the current end date, moves credit, and marks overage periods billed. A second payment for an already-paid invoice becomes account credit. Money is never lost.
- **SSLCommerz:** callbacks are untrusted input. The browser return and the IPN both lead to the server-to-server validation API, and amount, currency and `tran_id` must match. Everything after that network call is synchronous, so a redirect and an IPN for the same payment can't both activate the plan. `risk_level = 1` goes to manual review.
- **Manual bKash/Nagad:** the seller submits the TrxID and payer number. You approve or reject it in `/admin`, and the seller gets an SMS either way. TrxIDs are unique among non-rejected payments, so a rejected one can be retried but none can be reused.
- **Admin:** `/admin` is enabled only when `ADMIN_PASSWORD` is set. Login takes a constant-time password check, locks for 15 minutes after 5 failures, and uses a hashed session token in a `SameSite=Strict` cookie scoped to `/admin`, with CSRF tokens on every form.
- **Reminders:** an hourly job sends SMS at 5 days and 1 day before expiry, at the start of grace, and when the account drops to Free. Each one is sent at most once per paid period.

## Order pipeline

```
createOrder
  ├─ plan check (Free cannot automate orders)
  ├─ idempotency on (source, externalId)       ← webhook retries are safe
  ├─ normalise phone → HMAC hash
  ├─ gather signals: network history, seller history, return sellers,
  │                   24h burst, seller AOV, blocklist
  ├─ assessRisk(signals, policy) → score, level, action, reasons
  └─ act:
       auto_ship        → confirmed → maybe auto-book (Steadfast)
       confirm          → awaiting_confirmation + SMS link
       advance_payment  → awaiting_advance + SMS (bKash instructions on page)
       hold             → on_hold  (also forced for invalid phones)

customer link  /c/:code   confirm → confirmed (→ auto-book) | cancel → cancelled + network "cancelled"
seller actions            confirm | advance_received | hold | cancel(customerRefused)
bookCourier               confirmed → booked
syncShippedOrders (timer) booked → in_transit → delivered | returned  (+ network outcome)
recordOutcome (manual)    confirmed/booked/in_transit → delivered | returned (+ network outcome)
```

State transitions are enforced in `domain/order-state.ts`. Each transition writes an `order_events` row with the actor (`risk_engine`, `customer`, `seller`, `courier:steadfast`, …).

## Risk model

An additive points model (see `src/risk/score.ts`). The sum of the reason points equals the score, which the tests check.

| Signal | Points |
|--------|--------|
| Base (any COD order) | +10 |
| No delivery history | +20 |
| History: smoothed return rate *r* (prior 20%, strength 2; seller's own outcomes weighted ×1.5) | `round((r − 0.15) × 120)`, clamped −20…+65 |
| Past cancellations | +6 each, max +18 |
| Returns to 2 / ≥3 different sellers | +15 / +25 |
| ≥3 / ≥5 other orders in 24h (any seller) | +12 / +25 |
| High value (≥3× seller AOV, min ৳2,000; ৳5,000 if AOV unknown) | +10 (+5 if no history) |
| Vague address (<15 chars or <3 words) | +10 |
| Placed 00:00–05:59 Dhaka time | +5 |
| Invalid phone | +50 |
| Prepaid (COD amount 0) | −30 |
| Blocked by this seller | score = 100 |

Default thresholds: medium 30, high 60, critical 80. Growth+ sellers can override them and turn off advance payment.

**The weights are priors, not truth.** After about 2,000 labelled outcomes, fit them (logistic regression on the same features is the obvious first step). Keep the reason-based explanation even if the model changes.

## Data model (SQLite)

| Table | Purpose |
|-------|---------|
| `sellers` | Profile, plan, settings, API key **hash**, webhook secret |
| `orders` | The seller's orders, including the raw phone (needed to ship) and `phone_hash` |
| `order_events` | Append-only audit log of transitions |
| `network_outcomes` | One row per order outcome: `phone_hash`, `seller_id`, `delivered`/`returned`/`cancelled` |
| `blocklist` | Per-seller blocked `phone_hash`es |
| `usage` | Per seller per month: orders, risk checks, SMS, SMS segments |
| `courier_accounts` | Courier credentials, AES-256-GCM sealed with `APP_ENCRYPTION_KEY` |
| `sms_log` | Every SMS attempt with provider response |
| `sessions` | Dashboard sessions: token **hash**, seller, expiry |
| `login_codes` | SMS login codes: code **hash**, attempts, expiry, used-at |
| `invoices` | One row per purchase attempt: plan, cycle, line items (plan + overage), credits, total, 24h expiry, paid-at |
| `payments` | SSLCommerz / bKash / Nagad / credit attempts. A partial unique index stops a TrxID (or bank transaction) from paying twice |
| `admin_sessions` | Admin console sessions: token **hash**, expiry |

Sellers also carry their subscription (`plan_paid_until`, `plan_cycle`, `plan_daily_rate`, `credit_bdt`). `usage.overage_orders` and `overage_invoice_id` track extra orders until they are billed.

Migrations are append-only SQL in `db/migrations.ts`, tracked with `PRAGMA user_version`.

## Privacy and security

- **Network data is pseudonymous.** Cross-seller queries use `HMAC-SHA256(NETWORK_HASH_SECRET, phone)`. A plain SHA-256 of an 11-digit number could be reversed by brute force over the roughly 10⁹ possible numbers; a keyed HMAC cannot be reversed without the secret. Sellers never see another seller's customers, only aggregate counts.
- **No public lookup endpoint.** Risk checks need an API key and are metered, to prevent scraping of the network.
- API keys are stored as SHA-256 hashes. Webhooks are verified with constant-time HMAC comparison. Courier credentials are encrypted at rest.
- In production the server refuses to start with development secrets or the console SMS provider.
- The customer page needs no JavaScript, renders server-side, escapes all values, and is `noindex`.
- **Legal:** the seller Terms of Service must include consent to share delivery outcomes in pseudonymous form. Have this reviewed against current Bangladeshi data-protection law before launch.

## Couriers

`CourierAdapter` has two methods, `createParcel` and `getStatus`. Each adapter maps the courier's raw statuses onto `pending | in_transit | delivered | returned | cancelled`. Pure mapping functions are unit-tested. HTTP shapes are tested against mocks only, so **verify them against each courier's sandbox before production**.

- **Steadfast:** `Api-Key` / `Secret-Key` headers. A booked parcel that ends `cancelled` is treated as returned.
- **Pathao:** OAuth password grant, with the token cached until 60 s before expiry. Booking needs a store id and can take city, zone and area ids.
- **RedX:** `API-ACCESS-TOKEN: Bearer …`. Needs a delivery area id and name and a pickup store id. Phones must be `01XXXXXXXXX`.

Only Steadfast is auto-booked, because Pathao and RedX need per-order area ids. An area-resolution helper (district/thana → courier ids) is on the roadmap.

## Scaling path

| Stage | Change |
|-------|--------|
| Now – ~500 sellers | SQLite (WAL) on one VPS via `compose.yaml`: Caddy for HTTPS, Litestream streaming to S3-compatible storage, automatic restore onto an empty server ([07-deployment](07-deployment.md)) |
| Status sync slows down | Batch per courier, add courier webhooks, move the timer to a worker process |
| > ~500 sellers or a second app server | Implement `Store` on Postgres (the SQL is portable); keep the same service layer |
| Dashboard | Server-rendered pages or a Next.js app calling the same `/v1` API |
| WhatsApp / IVR | New providers behind the same "customer response" flow; the page and state machine don't change |

## Testing

`npm test` runs 109 tests:

- Unit tests: phone formats, the state machine, SMS segmenting, crypto, plans and config guards.
- Risk scenarios, including that reason points sum to the score.
- Courier adapters and store-payload mapping against fake `fetch`.
- An end-to-end API test of the full loop: order → SMS → customer confirms → Steadfast booking → status sync → delivered → the same customer auto-ships next time → a second seller is protected by the first seller's returns.
- Dashboard tests through a cookie-keeping test client:
  - login: SMS code, replay, wrong-guess and resend limits, expiry, not revealing which numbers are registered, API-key login, logout;
  - security: CSRF rejection, XSS escaping, seller isolation;
  - workflow: the full order flow through forms, tab, risk and Bangla-digit search filters;
  - settings: validation and plan gates.
- Subscription maths: states, upgrade credit, renewal stacking (including during grace), MRR.
- Billing end-to-end:
  - SSLCommerz: payment activates the plan exactly once (browser return plus IPN); forged and underpaid callbacks are rejected; risky payments go to review; cancel and gateway errors are handled;
  - manual payments: TrxID format checks, duplicate TrxID across sellers, approve, reject and retry;
  - plan changes: upgrade credit, downgrade into credit, stacked renewals, overage recorded live and billed once;
  - lifecycle: grace and expiry, each reminder sent once;
  - admin: lockout, CSRF, disabled without a password.
