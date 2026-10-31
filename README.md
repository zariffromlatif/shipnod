# Shipnod

*Get the customer's nod before you ship.*

**Stop paying for parcels that come back.** Shipnod scores every cash-on-delivery order for return risk, gets the customer to confirm by SMS (in Bangla), books Steadfast / Pathao / RedX in one call, and learns from every delivery outcome across all sellers.

Built for Bangladeshi online sellers: Facebook-page (F-commerce) shops, WooCommerce and Shopify stores doing 300–5,000 COD orders a month.

## Why this project

Vendor sources claim COD is 80–90% of Bangladeshi e-commerce and that 20–40% of parcels come back for many operators. Treat both as claims; checking them is part of the plan. Every returned parcel costs the seller a delivery charge, a return charge, packaging, and the ad spend that bought the order. That is a cash loss sellers see every month, and it is what makes this the highest-probability earner of the eight ideas scored in [docs/01-brainstorm.md](docs/01-brainstorm.md).

| Doc | What's in it |
|-----|--------------|
| [01 — Brainstorm](docs/01-brainstorm.md) | 8 ideas, weighted scoring, why this one, evidence |
| [02 — Business plan](docs/02-business-plan.md) | Cost of an RTO, ROI, pricing, unit economics, targets, kill criteria, risks |
| [03 — Product spec](docs/03-product-spec.md) | Personas, flows, risk levels, SMS templates, metrics |
| [04 — Architecture](docs/04-architecture.md) | System design, data model, privacy, scaling path |
| [05 — Go-to-market](docs/05-go-to-market.md) | 90-day plan, channels, funnel math |
| [06 — Sales playbook](docs/06-sales-playbook.md) | Bangla/English scripts, demo, objections, pilot offer |
| [Roadmap](docs/ROADMAP.md) | v0.1 (this code) → v1.0 |

## How it works

```
order (API / WooCommerce / Shopify)
   │
   ▼
risk score 0–100 with reasons ──► low (<30)       → auto-ship (optionally auto-book courier)
   (network history, returns       medium (30–59)  → SMS link: customer confirms or cancels
    to other sellers, order        high (60–79)    → SMS: pay delivery charge via bKash first
    bursts, address, value…)       critical (≥80)  → hold for review
   │
   ▼
courier booking (Steadfast / Pathao / RedX) ──► status sync ──► delivered / returned
                                                                    │
                     shared network (HMAC-hashed phones) ◄──────────┘
```

Every score is explained in English and Bangla ("Returned 3 of 4 past orders", "৫টি অর্ডার গত ২৪ ঘণ্টায়"), so sellers trust it.

## Quick start

Requires Node.js ≥ 22.13 (uses the built-in `node:sqlite`; there are no native dependencies).

```bash
npm install
cp .env.example .env            # dev defaults work as-is
npm run seller:create -- --name "Rahim" --shop "Rahim Fashion" --plan growth --phone 01712345678
npm run dev                     # http://localhost:8787
```

Create an order with the API key printed above:

```bash
curl -X POST localhost:8787/v1/orders \
  -H "authorization: Bearer nsk_..." -H "content-type: application/json" \
  -d '{"customerName":"Karim","phone":"০১৭১২৩৪৫৬৭৮","address":"House 12, Road 5, Dhanmondi, Dhaka",
       "codAmount":1450,"items":[{"name":"Panjabi","quantity":1,"unitPrice":1450}]}'
```

The console prints the confirmation SMS. Open its link to see the customer's page.

### Seller dashboard

Sellers work in a Bangla, mobile-first dashboard at **`/app`**. They log in with their phone number and a 6-digit SMS code. To get a filled-in shop for a demo or for UI work:

```bash
DATABASE_PATH=./data/demo.db npm run seed:demo
DATABASE_PATH=./data/demo.db npm run dev
# open http://localhost:8787/app/login and enter 01700000000. The login code is printed in this terminal.
```

| Page | What sellers do there |
|------|-----------------------|
| Overview `/app` | Estimated taka saved, RTO rate, to-do counts (held, to book, awaiting advance, awaiting the customer), monthly usage, quick customer check, recent orders |
| Orders `/app/orders` | Tabs by stage, filter by risk level, search by name, number (any format, including Bangla digits) or order id |
| Order `/app/orders/:id` | Why it was flagged (each reason with its points), confirm / advance received / hold / cancel, resend SMS, book a courier, record delivered or returned, full timeline |
| New order `/app/orders/new` | Type in an order from Facebook or a phone call. It is scored and acted on as it is saved |
| Customer check `/app/check` | Look up a number before taking the order |
| Settings `/app/settings` | Shop name, SMS language with a cost preview, bKash number and advance fee, auto-booking, risk thresholds (Growth+), courier accounts, webhook URLs, blocklist, plan usage |

```bash
npm test          # 85 tests: risk engine, adapters, webhooks, API loop, dashboard
npm run typecheck
npm run build && npm start
```

## API

All `/v1` routes need `Authorization: Bearer <api key>`.

| Method & path | Purpose |
|---------------|---------|
| `GET /v1/me` · `PATCH /v1/me` | Profile, plan, webhook URLs · settings (shop name, SMS language, advance fee, bKash number, auto-book courier, cost per failed order, custom risk policy) |
| `POST /v1/customers/check` | Score a phone number before taking an order (metered) |
| `POST /v1/orders` | Create an order; it is scored and acted on immediately |
| `GET /v1/orders?status=` · `GET /v1/orders/:id` | List · detail with full event history |
| `POST /v1/orders/:id/actions` | `confirm` · `cancel` (`customerRefused`) · `hold` · `advance_received` |
| `POST /v1/orders/:id/resend` | New link + SMS |
| `POST /v1/orders/:id/book` | Book with a courier (`courier`, `area`, `weightKg`) |
| `POST /v1/orders/:id/outcome` | Record `delivered` / `returned` for parcels shipped outside Shipnod |
| `PUT /v1/couriers/:courier` · `GET /v1/couriers` | Connect courier credentials (encrypted at rest) |
| `POST /v1/blocklist` · `DELETE /v1/blocklist/:phone` | Seller blocklist |
| `GET /v1/stats?days=30` · `GET /v1/usage` | RTO rate, money saved · plan usage and overage |
| `POST /webhooks/woocommerce/:sellerId` · `/webhooks/shopify/:sellerId` | Signed store webhooks (Growth+) |
| `GET /c/:code` · `POST /c/:code` | Customer confirmation page |

## Pricing (BDT / month)

| Free | Starter | Growth | Scale |
|------|---------|--------|-------|
| ৳0 · 100 customer checks | ৳990 · 500 orders · 1 courier | ৳2,490 · 2,000 orders · all couriers · Woo/Shopify · custom rules | ৳5,990 · 6,000 orders · voice confirm · multi-user |

Overage costs ৳1.5 per order. Annual plans get 2 months free. Paid onboarding (৳3,000–5,000) brings in cash from week one. Limits are enforced in [`src/billing/plans.ts`](src/billing/plans.ts).

## Before going live

- [ ] **Verify each courier adapter against its sandbox / merchant docs.** The endpoints follow the couriers' merchant APIs as used by community SDKs. They are unit-tested against mocks, not against live accounts.
- [ ] Register an SMS sender ID with a Bangladeshi gateway and set `SMS_PROVIDER=http` (see `.env.example`).
- [ ] Generate production secrets: `openssl rand -hex 32` for `NETWORK_HASH_SECRET` and `APP_ENCRYPTION_KEY`. The server refuses to start in production without them.
- [ ] Publish Terms of Service and a privacy policy that cover sharing delivery outcomes across the network, and have a lawyer check them against current Bangladeshi data-protection rules.
- [ ] Use a short domain for `PUBLIC_BASE_URL`. Every character of a Bangla SMS costs money.

## License

Proprietary. All rights reserved.
