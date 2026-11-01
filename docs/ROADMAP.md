# Roadmap

Each release ships only after the previous one is used by paying sellers. Dates are deliberately absent: progress is gated by the checkpoints in [02-business-plan.md](02-business-plan.md), not by the calendar.

## v0.1 — Code foundation (this repository) — done

- [x] Bangladeshi phone normalisation (`01XXXXXXXXX`, `+880`, `880`, Bangla digits) and validation
- [x] Explainable risk engine: 0–100 score, level (low < 30, medium 30–59, high 60–79, critical ≥ 80), reasons in English and Bangla, recommended action
- [x] HMAC hashing of phone numbers for the shared cross-seller network
- [x] Network history: delivered / returned / cancelled outcomes per hashed phone, multi-seller return and 24h order-burst signals
- [x] Random, expiring, single-answer confirm/cancel links with a Bangla mobile page (incl. bKash advance-payment flow)
- [x] Confirmation SMS templates in Bangla, Banglish and English with segment counting; console provider + generic HTTP gateway provider
- [x] Courier adapters for Steadfast, Pathao and RedX behind one interface, plus a polling status-sync job — **verify every endpoint and field against each courier's sandbox before production use**
- [x] WooCommerce and Shopify webhooks with signature verification and idempotent import
- [x] SQLite store (built-in `node:sqlite`, single VPS), courier credentials encrypted with AES-256-GCM
- [x] Per-seller API-key authentication and seller settings
- [x] Plan limits (Free / Starter / Growth / Scale) and usage/overage metering
- [x] Stats endpoint: RTO rate, orders stopped before shipping, estimated money saved
- [x] Tests (69) and CI

## v0.2 — Sellable product

- [x] Seller dashboard (server-rendered, Bangla-first, mobile-friendly) with phone + SMS-code login
- [x] Order inbox with tabs by stage, risk-level filter and search; one-click courier booking; manual order entry
- [x] Savings overview: estimated taka saved, RTO rate, to-do counts, plan usage
- [x] Demo-shop seed script for sales demos (`npm run seed:demo`)
- [ ] Analytics: confirmation rate, RTO by courier and by district
- [x] Billing: prepaid plans, invoices, SSLCommerz checkout (bKash/Nagad/cards), manual bKash/Nagad with admin approval, upgrade credit, overage billing, renewal reminders, grace → Free
- [x] Admin console: MRR, payment review, comp/pilot plans, and signing up sellers from a phone (welcome SMS + WhatsApp hand-off)
- [x] Production deployment kit: Docker Compose (Caddy HTTPS + Litestream backups, automatic restore), CLIs to create sellers, test SMS and take snapshots, and a step-by-step guide
- [ ] bKash tokenized checkout API directly (lower fees than via a gateway) once volume justifies the merchant onboarding
- [ ] Courier webhooks where available (polling sync already exists)
- [ ] CSV import of orders and historical outcomes
- [ ] Production SMS provider integration with registered sender ID
- [ ] Free "Customer Checker" (sign-up required, rate-limited, aggregate results only)
- [ ] Terms of Service and privacy policy pages with network-sharing consent

## v0.3 — More channels

- [ ] WhatsApp Cloud API confirmations (template messages, button replies)
- [ ] IVR voice-call confirmation (press 1 to confirm, 2 to cancel) for Scale
- [ ] Chrome extension for the Facebook page inbox: score a customer and create an order without leaving Messenger
- [ ] No-reply reminders and automatic hold rules
- [ ] Courier/district RTO breakdowns

## v0.4 — Expansion

- [ ] Bangla AI sales assistant (module B): answer price/stock questions in Messenger and comments, capture orders straight into Shipnod
- [ ] Multi-user accounts with roles (owner, ops, caller)
- [ ] Migrate SQLite to Postgres when the base passes roughly 500 sellers or write load requires it
- [ ] Learned risk model trained on network outcomes (keep explanations)

## v1.0 — Platform

- [ ] Courier rate shopping: recommend the cheapest/most reliable courier per district
- [ ] Advanced analytics: cohort RTO, product-level returns, ad-campaign quality by RTO
- [ ] Public API and webhooks for agencies and larger sellers
- [ ] Partner/reseller portal with commission tracking
- [ ] Evaluate expansion to other COD-heavy markets
