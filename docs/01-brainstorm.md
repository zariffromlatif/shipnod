# 01 — Brainstorm: which project has the highest realistic chance of earning money?

## The question

Pick one project a Dhaka-based developer-founder can build and sell, optimising for the **probability of real, recurring revenue** — not for the size of the upside if everything goes right. Complexity is acceptable; uncertainty about whether anyone pays is not.

## What "high probability" means here

A project earns money reliably when most of these are true:

1. **It removes a cost the buyer already feels in taka every month.** Pain that shows up in the bank balance sells itself; "nice to have" does not.
2. **Buyers are easy to reach** without an ad budget or an existing audience.
3. **There is evidence people already pay** for something similar (competitors are a good sign, not a bad one).
4. **Money can actually reach the founder.** Stripe does not support Bangladesh, and PayPal receiving is not generally available to Bangladeshi accounts (verify current status). Anything that depends on those rails carries payout risk.
5. **The founder has an unfair advantage**: language, location, network, or skill others lack.
6. **Short time to first taka**, so the idea is validated or killed in weeks, not quarters.
7. **Competition is beatable** with a better product, a narrower focus, or a local edge.
8. **It can scale** past the founder's hours.

## Ideas considered

| ID | Idea | One-line description |
|----|------|----------------------|
| A | **Shipnod — COD order-ops for Bangladeshi sellers** | Score every cash-on-delivery order for return risk, auto-confirm it by SMS (Bangla), book the courier in one click, and learn from each delivery outcome across all sellers. |
| B | Bangla AI sales assistant for Facebook pages / WhatsApp | Auto-reply to "price?" comments and DMs in Bangla, capture orders, hand off to staff. |
| C | Global Shopify COD-confirmation app | WhatsApp/SMS confirmation for COD orders, sold through the Shopify App Store in USD. |
| D | AI automation agency / productized services for foreign SMBs | Build chatbots, automations and integrations for clients abroad, paid per project or retainer. |
| E | Developer boilerplates / templates | Sell SaaS starter kits or UI templates via a merchant-of-record (Lemon Squeezy, Paddle, Polar, Gumroad). |
| F | Android utility apps with ads / in-app purchases | Publish small utilities and monetise with AdMob and IAP. |
| G | Generic AI-wrapper SaaS (global) | A writing/image/summary tool on top of an LLM API. |
| H | Coaching-centre / school management SaaS (Bangladesh) | Fees, attendance, results and guardian SMS for coaching centres and small schools. |

## Scoring matrix

Scores are 1 (bad) to 5 (good). "Competition" is inverse: 5 means little effective competition. Weights reflect what drives *probability* of revenue: money-pain, reachability, willingness-to-pay evidence and speed count most. Scores are the founder's judgement, informed by the evidence section below; they are not measurements.

| Criterion | Weight | A | B | C | D | E | F | G | H |
|-----------|:------:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Money-pain severity | 2.0 | 5 | 4 | 4 | 3 | 2 | 1 | 2 | 3 |
| Buyer reachability | 1.5 | 5 | 5 | 3 | 3 | 2 | 2 | 2 | 3 |
| Willingness-to-pay evidence | 1.5 | 4 | 3 | 5 | 4 | 3 | 1 | 2 | 3 |
| Payment rails from Bangladesh | 1.0 | 5 | 5 | 2 | 3 | 3 | 3 | 3 | 5 |
| Founder unfair advantage | 1.0 | 5 | 4 | 2 | 4 | 3 | 3 | 3 | 3 |
| Time to first taka | 1.5 | 4 | 3 | 2 | 5 | 3 | 2 | 3 | 3 |
| Competition (inverse) | 1.0 | 3 | 2 | 1 | 2 | 1 | 1 | 1 | 2 |
| Scalability | 1.0 | 3 | 4 | 5 | 1 | 4 | 3 | 4 | 3 |
| **Weighted total (max 52.5)** | | **45.5** | **39.5** | 33.0 | 34.0 | 27.0 | 19.5 | 25.5 | 32.5 |
| **Rank** | | **1** | **2** | 4 | 3 | 6 | 8 | 7 | 5 |

### Notes on the scores

- **A — Shipnod.** Every returned COD parcel costs the seller a forward delivery charge, a return charge, packaging and the ad spend that bought the order. That loss is visible every month, so ROI is easy to show. Sellers are concentrated in reachable Facebook groups. Payment is local (bKash, Nagad, SSLCommerz). A Bangla-speaking founder in Dhaka can sit with sellers, which a foreign competitor cannot. Competition exists (see below), which is why it scores 3, not 5. ARPU in BDT is modest, which caps scalability at 3 until the product expands.
- **B — Bangla AI sales assistant.** Same buyers as A, so reachability and rails are equally good. Pain is real (staff spend hours answering "price?"), but it is harder to put a taka number on, many chatbot tools already exist, and LLM quality in Bangla still needs work. **It is the natural cross-sell module after A**, not the starting point.
- **C — Global Shopify COD app.** Proven demand: several COD-confirmation apps charge USD monthly fees. But the category is crowded, ranking in the App Store takes months, and getting Shopify partner payouts into Bangladesh adds friction.
- **D — Services.** Fastest cash for a skilled developer, and payable via Payoneer or wire. But revenue stops when the founder stops working, and it does not compound. Useful as a bridge, not as the project.
- **E, G — Templates and AI wrappers.** Global and scalable, but crowded, and they depend on an audience the founder does not yet have.
- **F — Android ad apps.** Very low revenue per user, heavy competition, and income depends on store algorithms. Lowest probability.
- **H — Coaching-centre SaaS.** Local rails and a real need, but buyers are price-sensitive, sales cycles are slower, and the pain is administrative rather than a direct monthly cash loss.

## Decision

**Build A (Shipnod).** It has the best combination of a cash-denominated pain, reachable buyers, local payment rails and a local founder advantage.

Two honest caveats are built into the plan:

1. **D is the fastest cash, so we borrow its strength without becoming an agency.** Shipnod charges a one-time paid onboarding/setup fee (3,000–5,000 BDT) for courier and store integration and historical data import. That brings in cash in the first weeks while the subscription base grows.
2. **B is the planned second module** (roadmap v0.4). Once sellers trust Shipnod with their orders, a Bangla sales assistant that captures orders directly into Shipnod raises ARPU without new acquisition cost.

## Evidence

All of these are external sources. Vendor and community pages are marketing material, so treat their numbers as claims, not facts.

| Source | Type | What it shows |
|--------|------|---------------|
| [eGrow — Bangladesh COD & WhatsApp (2026)](https://www.egrow.com/en/blog/bangladesh-cod-whatsapp-2026) | Vendor blog (also a competitor) | Claims COD is 80–90% of Bangladeshi e-commerce transactions and that RTO rates hover around 20–40% for many operators. Unsourced vendor figures. eGrow sells a COD-operations platform, which itself confirms that the category exists. |
| [Confirmify WhatsApp COD Verify (Shopify App Store)](https://apps.shopify.com/confirmify) | App listing | COD confirmation is a paid product category: plans from $9.99/month to $69.99/month. |
| [FraudSpy: COD Fraud Checker (Shopify App Store)](https://apps.shopify.com/fraudspy) | App listing | A Bangladesh-built COD fraud checker for Shopify, listed in 2026. |
| [Naimur Courier Ratio Checker (WordPress plugin)](https://wordpress.org/plugins/naimur-courier-ratio-checker/) | Community plugin | WooCommerce sellers want courier success-ratio checks by phone number. |
| [OrderFlow Fraud Checker (Chrome Web Store)](https://chromewebstore.google.com/detail/gheeoaoabeafpehidgeihdobbfmcneii) | Browser extension | Phone-number fraud checks aimed at Bangladeshi sellers, inside the browser. |
| [azmolla/fraud-checker-bd-courier (Packagist)](https://packagist.org/packages/azmolla/fraud-checker-bd-courier) | Developer package | Developers build phone checks across Steadfast, Pathao and RedX for clients. |

### What the evidence means

- **Demand is validated.** Many people have independently built COD fraud checkers for Bangladesh: plugins, extensions, packages, Shopify apps. People do not build that many tools for a problem nobody has.
- **A phone lookup on its own is commoditised.** Several of these tools are free and single-purpose. Competing on "check a number" alone would be a race to zero.
- **Shipnod's angle is the closed loop:** check the customer, then confirm the order automatically, then book the courier, then record the delivery outcome. Each outcome improves the shared network data, which improves the next check. Single-feature checkers do not get better with use; Shipnod does.

### What we do not know yet (verify in the first 30 days)

- The real per-seller RTO rate and cost per failed order. The plan assumes 120–250 BDT per failed order (see [02-business-plan.md](02-business-plan.md)); interviews must confirm or correct this.
- Whether sellers will pay a monthly fee or prefer per-order pricing.
- Official courier API coverage for status sync. The adapters must be checked against each courier's sandbox.
