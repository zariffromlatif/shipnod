# 02 — Business plan

## One-liner

**Shipnod ("get the customer's nod before you ship") helps Bangladeshi online sellers ship only the cash-on-delivery orders that will actually be accepted.** It scores each order for return risk, confirms it automatically by SMS in Bangla, books Steadfast, Pathao or RedX in one click, and learns from every delivery outcome across all sellers on the network.

## The problem

Most Bangladeshi online orders are cash on delivery. A vendor source claims COD is 80–90% of e-commerce transactions and that return-to-origin (RTO) rates hover around 20–40% for many operators ([eGrow](https://www.egrow.com/en/blog/bangladesh-cod-whatsapp-2026), vendor claim). Whatever the exact figure, every seller we target knows the pattern: a customer orders on Messenger or a website, the parcel goes out, and the customer refuses it, does not answer the phone, or "did not order".

### What one returned order costs the seller

**Assumption to verify in seller interviews:** about **120–250 BDT per failed order**, made up of:

| Cost component | Notes |
|----------------|-------|
| Forward delivery charge | Paid to the courier even though no cash is collected. Higher outside Dhaka. |
| Return charge | Many couriers charge for returning the parcel. |
| Packaging and handling | Box, poly, label, staff time. |
| Wasted ad spend | The Facebook ad money that bought an order that never paid. Often the largest hidden cost. |
| Damage and dead stock | Returned items can be damaged or miss their selling season. Not counted in the range above. |

The plan uses **150 BDT per failed order** as the working figure.

### Worked ROI example

| | Before Shipnod | With Shipnod (target) |
|--|-----------------|------------------------|
| Orders shipped per month | 1,000 | 1,000 |
| RTO rate | 25% | 15% |
| Failed deliveries | 250 | 150 |
| Loss at 150 BDT each | **37,500 BDT/month** | **22,500 BDT/month** |
| Saving | | **15,000 BDT/month** |
| Shipnod Growth plan | | 2,490 BDT/month |
| Return on subscription | | **about 6x** |

The 10-point RTO reduction is a **target to be measured in pilots**, not a proven result. The pilot offer (see [06-sales-playbook.md](06-sales-playbook.md)) measures it against each seller's own baseline.

## Customer

**Ideal customer profile:** a Bangladeshi seller doing **300–5,000 COD orders per month** through a Facebook page (F-commerce), a WooCommerce store or a Shopify store. Typical categories: fashion, cosmetics, gadgets, home goods, food. They already use Steadfast, Pathao or RedX, have 1–5 staff, and currently confirm orders by phone or not at all.

Below 300 orders/month, the loss is too small to justify a subscription (the Free plan serves them as future customers). Above 5,000, sellers often build in-house tools or want custom contracts (handled case by case on Scale).

## Product (summary)

Full detail in [03-product-spec.md](03-product-spec.md).

1. **Risk check** by phone number: own-store history plus shared, HMAC-hashed delivery history across all Shipnod sellers, plus order signals.
2. **Order inbox:** orders arrive from WooCommerce/Shopify webhooks, CSV import, manual entry or the API.
3. **Risk-based action:** low risk ships automatically; medium risk gets an SMS confirm/cancel link in Bangla; high risk is asked to pay the delivery charge in advance via bKash; critical risk is held or blocked.
4. **One-click courier booking** with Steadfast, Pathao and RedX.
5. **Outcome sync:** delivered/returned status flows back and improves the network.
6. **Savings dashboard:** RTO rate, confirmation rate and estimated taka saved.

## Pricing

All prices in BDT per month. These must match the plan limits in code.

| Plan | Price | Included | For |
|------|------:|----------|-----|
| Free | 0 | 100 risk checks/month, no automated orders | Small sellers, trial, lead generation |
| Starter | 990 | 500 orders/month, 1 courier | Facebook-page sellers |
| Growth | 2,490 | 2,000 orders/month, all couriers, WooCommerce/Shopify, custom risk rules | Growing stores |
| Scale | 5,990 | 6,000 orders/month and everything in Growth. *Planned, not built yet:* voice-call confirmation, multi-user | Larger operations |

- **Overage:** 1.5 BDT per order above the plan quota.
- **Selling Scale today:** until voice confirmation and multi-user ship (roadmap v0.3/v0.4), Scale is a volume plan. Above about 4,300 orders a month it costs less than Growth plus overage (2,490 + 1.5 × (orders − 2,000)). Sell it on that, never on the planned features.
- **Annual prepay:** 2 months free (pay for 10, get 12).
- **One-time paid onboarding / setup:** 3,000–5,000 BDT for courier and store integration, historical order import and template setup. This is the services revenue bridge: it brings in cash in the first weeks and funds founder time. The first 10 pilot sellers can have it waived in exchange for a case study.
- **Payment methods:** bKash and Nagad, plus SSLCommerz for cards and bank transfer. Monthly invoice with a payment link; automatic renewal where the payment provider supports it.

### Blended ARPU assumption

Planning uses **~1,800 BDT blended ARPU**, assuming a Starter-heavy mix of about 55% Starter, 38% Growth and 7% Scale (list-price average about 1,910 BDT), less annual-prepay discounts, plus some overage. Recheck this after the first 30 paying customers.

## Unit economics

**All costs below are assumptions** to be replaced with real supplier quotes.

| Assumption | Value |
|------------|-------|
| SMS cost | 0.30–0.60 BDT per SMS; 0.45 BDT used below |
| Orders that need an SMS (medium + high risk) | ~50% of orders |
| SMS per order that needs one | ~1.2 (some reminders) |
| Typical usage | ~60% of plan quota |
| Payment processing fees | ~2.5% of revenue |
| Voice-call confirmation (Scale) | ~1 BDT per call, ~10% of orders |

Bangla text is sent as Unicode SMS, which fits about 70 characters per segment versus 160 for Latin text. Long Bangla messages cost two or more segments, so templates must stay short or offer a Banglish (Bangla in Latin script) option.

### Gross margin per plan (typical usage)

| Plan | Price | Orders used | SMS cost | Voice cost | Infra share | Payment fees | Gross margin |
|------|------:|------------:|---------:|-----------:|------------:|-------------:|-------------:|
| Starter | 990 | 300 | 81 | 0 | 30 | 25 | **~86%** |
| Growth | 2,490 | 1,200 | 324 | 0 | 60 | 62 | **~82%** |
| Scale | 5,990 | 3,600 | 972 | 360 | 150 | 150 | **~73%** |

**Worst case** (Growth seller uses the full 2,000 orders, every order gets 1.2 SMS at 0.60 BDT): SMS cost 1,440 BDT, gross margin about 37%. Still positive. Controls: a fair-use cap of 2 SMS per order, Banglish templates, SMS only for medium/high risk, and later WhatsApp for customers who use it.

### Fixed costs (assumption)

| Item | Estimate |
|------|----------|
| VPS (single server, SQLite at first) | ~$10–20/month |
| Backups, domain, email | small |
| SMS sender ID / masking registration via SMS provider | one-time, provider-dependent |
| Total early fixed cost | roughly 5,000 BDT/month |

Infrastructure breaks even at a handful of paying sellers. The real cost is founder time, which the onboarding fees partly fund.

## Revenue targets

**These are targets, not promises or forecasts.** They assume the outreach volume in [05-go-to-market.md](05-go-to-market.md) and ~1,800 BDT blended ARPU.

| Checkpoint | Paying sellers (target) | MRR (target) | Notes |
|------------|------------------------:|-------------:|-------|
| Day 30 | 5–10 paid pilots | ~5,000–20,000 BDT | Plus one-time setup fees from non-waived customers |
| Month 3 | 40–60 | ~72,000–108,000 BDT | |
| Month 6 | 100–150 | ~180,000–270,000 BDT | |
| Month 12 | 200–350 | ~360,000–630,000 BDT | Roughly $3,000–5,250/month at an assumed 120 BDT/USD |

### Kill / pivot criteria

Decide on evidence, not hope.

| Checkpoint | Condition | Action |
|------------|-----------|--------|
| Day 45 | **Fewer than 5 paying pilots** after real outreach (at least ~300 targeted DMs and 20 demos) | Stop building features. Re-interview. Pivot to module B (Bangla AI sales assistant, same buyers) or lean on the services bridge while re-testing. |
| Day 45 | Pilots show **no measurable RTO reduction** vs baseline | Fix the risk model or confirmation flow before any more sales. If still flat at day 75, pivot. |
| Month 3 | Monthly logo churn **above 10%** | Pause acquisition; fix onboarding and value delivery. |
| Month 6 | Fewer than 60 paying sellers | Reassess pricing (per-order pricing), segment (larger sellers only) or market (other COD markets). |

## Competition and positioning

| Alternative | What it does | Weakness | Shipnod's position |
|-------------|--------------|----------|---------------------|
| Free fraud-checker plugins, extensions and packages ([example](https://wordpress.org/plugins/naimur-courier-ratio-checker/), [example](https://chromewebstore.google.com/detail/gheeoaoabeafpehidgeihdobbfmcneii), [example](https://packagist.org/packages/azmolla/fraud-checker-bd-courier)) | Look up a phone number's courier success ratio | Manual, single feature, does not act on the result, often fragile | Automatic check on every order, then action, then booking, then outcome |
| [eGrow](https://www.egrow.com/en/blog/bangladesh-cod-whatsapp-2026) | COD operations platform across several markets | Broad multi-market product, not Bangladesh-only | Bangladesh-native, Bangla-first, BDT pricing, local support in person |
| Couriers' built-in checks | A courier's own data inside its merchant panel | Usually one courier's view, manual lookup | Combines courier-agnostic network data with order signals and acts automatically |
| Staff confirming by phone | A person calls every customer | Costs salary, slow, inconsistent, does not scale | Automates the easy majority; gives callers a short priority list of risky orders |
| Shopify COD-confirmation apps ([example](https://apps.shopify.com/confirmify)) | WhatsApp confirmation | USD pricing, Shopify-only, no Bangladeshi courier booking | Works for Facebook-page, WooCommerce and Shopify sellers; books local couriers |

**Moat, in order of strength:**

1. **Network data effect.** Every delivered or returned parcel on Shipnod improves risk scores for every seller. A new competitor starts with no data.
2. **Closed loop.** Check, confirm, book and learn in one place, so switching means rebuilding the workflow.
3. **Local fit.** Bangla UX and messages, bKash/Nagad billing, in-person onboarding in Dhaka.
4. **Integrations.** Steadfast, Pathao, RedX, WooCommerce, Shopify, and later WhatsApp and voice.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Courier APIs change or are undocumented | High | Isolate each courier behind an adapter; test against each courier's sandbox; monitor for errors; keep manual booking as a fallback. |
| Terms-of-service violations | Medium | **Never scrape courier merchant portals or log into seller courier accounts to pull data.** Use official APIs with the seller's own credentials and our own consented network data only. |
| Personal-data law | Medium | Bangladesh's personal-data protection law has been in flux; **check its current status with a lawyer before launch.** By design, the shared network stores only HMAC-hashed phone numbers and outcome counts, never another seller's raw customer data. Seller ToS includes explicit consent for network sharing; deletion on request. |
| SMS deliverability and cost | Medium | Use a reputable local SMS provider with a registered sender ID; keep messages short; cap SMS per order; add WhatsApp later. |
| Small-seller churn | High | Target 300+ orders/month sellers; show taka saved on the dashboard every month; annual prepay discount; onboarding that imports past outcomes so value appears on day one. |
| Low ARPU in BDT | High | Paid onboarding; Scale plan; overage; module B cross-sell; later expansion to other COD-heavy markets. |
| Competitors copy features | High | Compete on network data and integration depth, not on the phone lookup. |
| Seller misuse (blacklisting customers unfairly) | Medium | Scores are explainable with reasons; the network reflects delivery outcomes, not seller opinions; customers can confirm via the link to clear a hold. |
| Founder bandwidth | High | Concierge-first, automate what repeats; resellers and partners for distribution. |

## Legal and operations checklist

Check each item with an accountant or lawyer; requirements change.

- [ ] Trade license (city corporation)
- [ ] e-TIN for the business owner; BIN for VAT if required for software services
- [ ] Business bank account
- [ ] bKash and Nagad merchant accounts for collecting subscriptions
- [ ] SSLCommerz merchant account (cards, bank transfer)
- [ ] SMS provider contract and sender ID / masking registration
- [ ] Terms of Service with explicit **consent for sharing hashed delivery outcomes** across the network
- [ ] Privacy policy (what is stored, hashing, retention, deletion on request)
- [ ] Data processing terms for sellers who send customer data
- [ ] Check applicability of Bangladesh's digital commerce guidelines and current personal-data protection law
- [ ] Simple invoicing and bookkeeping from the first paid customer
