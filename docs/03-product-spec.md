# 03 — Product spec (MVP)

This document describes what the product does and why. The code is the source of truth for exact field names, endpoints and state transitions; see [04-architecture.md](04-architecture.md).

## Personas

All personas are composites for design purposes.

| Persona | Context | Today | What they want |
|---------|---------|-------|----------------|
| **F-commerce owner** | Facebook page, 400–1,500 orders/month, fashion or cosmetics. Takes orders in Messenger and comments. 1–2 staff. | Copies orders into a notebook or spreadsheet, books Steadfast manually, finds out about returns days later. | Fewer returned parcels without hiring another caller. Simple, in Bangla, works from a phone. |
| **WooCommerce / Shopify store owner** | 1,000–5,000 orders/month, gadgets, cosmetics or home goods. Has a developer or agency. 2–5 ops staff. | Staff call every COD order; couriers booked one by one; RTO tracked loosely in Excel. | Automation that plugs into the store, multiple couriers, clear RTO numbers by courier and district. |
| **Ops staffer / order caller** | Confirms orders by phone all day. | Calls everyone, including customers who always accept. | A short list of the orders that actually need a call. |
| **Agency / freelancer** (channel partner) | Builds WooCommerce/Shopify stores for sellers. | Gets asked "how do I reduce fake orders?" | Something reliable to install for clients, with recurring commission. |

## Jobs to be done

1. *When a COD order comes in,* I want to know whether this customer is likely to accept the parcel, *so I don't pay delivery and return charges for nothing.*
2. *When an order looks doubtful,* I want the customer to confirm it themselves, *so my staff don't spend hours calling.*
3. *When an order is confirmed,* I want to book the courier in one click, *so packing and dispatch are not slowed down by data entry.*
4. *At the end of the month,* I want to see my RTO rate and the money I saved, *so I know the tool is worth paying for.*

## MVP scope vs later

| Capability | MVP (v0.1–v0.2) | Later |
|------------|-----------------|-------|
| Phone normalisation (01XXXXXXXXX, +880, 880) | Yes | |
| Explainable risk score (0–100) with reasons | Yes | ML model trained on network outcomes |
| Shared network history (HMAC-hashed phones) | Yes | Courier/district-level insights |
| Order intake | WooCommerce and Shopify webhooks, API, manual entry; CSV import in v0.2 | Facebook page inbox via Chrome extension (v0.3) |
| Confirmation channel | SMS with signed confirm/cancel link | WhatsApp Cloud API, IVR voice call (v0.3) |
| Advance delivery charge for high risk | bKash payment link / instructions | Automatic payment verification |
| Courier booking | Steadfast, Pathao, RedX | Rate shopping across couriers (v1.0) |
| Delivery status sync | Webhook/polling job in v0.2 | |
| Dashboard | v0.2 | Advanced analytics (v1.0) |
| Billing | Plan limits in code; manual invoicing | bKash/SSLCommerz billing in v0.2 |
| Users | One API key per seller | Multi-user with roles (v0.4) |
| Bangla AI sales assistant (module B) | No | v0.4 |

## Risk levels and default actions

These thresholds must match the code.

| Level | Score | Default action | Rationale |
|-------|------:|----------------|-----------|
| **Low** | < 30 | **Auto-ship**: ready for courier booking without contacting the customer | Good history; contacting them only adds friction. |
| **Medium** | 30–59 | **Confirm via SMS**: customer gets a confirm/cancel link | Uncertain; a one-tap confirmation is cheap and filters fake orders. |
| **High** | 60–79 | **Require advance delivery charge via bKash** before shipping | History of returns; the advance covers the seller's delivery cost and filters non-serious orders. |
| **Critical** | ≥ 80 | **Hold / block**; staff review required | Repeated refusals or blocklisted; shipping is very likely to fail. |

Sellers on Growth and above can change thresholds and actions (custom risk rules). Every score shows its reasons, for example "Returned 4 of 6 network deliveries", "First order from this customer", "3 orders from this number in the last 24 hours", "Order value well above store average", "Address too short".

### Signals (MVP)

- Network history for the hashed phone number: delivered and returned counts across all sellers.
- Own-store history for the phone number.
- Seller blocklist.
- Order signals: order value versus the store's typical order, first-time customer, duplicate or rapid repeat orders from the same number, incomplete or very short address, invalid or unusual phone number.

New customers with no history get a neutral score from order signals only. Thin data must not be treated as bad data.

## User flows

### 1. Onboarding

1. Seller signs up and gets an API key (dashboard login arrives in v0.2).
2. Connects courier credentials: Steadfast API key and secret, Pathao client credentials, RedX access token. Credentials are stored per seller and used only for that seller's bookings.
3. Connects the store: WooCommerce or Shopify webhook, or uses the API/manual entry.
4. Optionally imports the last 90 days of order outcomes (delivered/returned). This seeds own-store history so scores are useful on day one.
5. Reviews message templates (Bangla, Banglish or English) and the per-failed-order cost used for "money saved" (default 150 BDT).
6. Sends one test order end to end.

### 2. Order lifecycle

```
order arrives (webhook / API / manual / CSV)
  -> phone normalised; invalid number flagged
  -> risk score computed with reasons
  -> action by level:
       low      -> ready to book
       medium   -> SMS with signed confirm/cancel link
       high     -> SMS asking for advance delivery charge via bKash
       critical -> on hold for staff review
  -> customer confirms or cancels on the link page (link expires)
       confirmed -> ready to book
       cancelled -> order closed before shipping (cost avoided)
       no reply  -> reminder once, then on hold for a staff call
  -> courier booked (one click, or automatically if enabled)
  -> status synced from courier: in transit -> delivered / returned
  -> outcome written to own-store history and to the network (hashed phone)
  -> dashboard metrics updated
```

### 3. Customer confirmation page

The SMS link opens a small no-JavaScript mobile page in Bangla showing the shop name, the last 6 characters of the order id, items, amount and delivery address, with two large buttons: **হ্যাঁ, অর্ডার নিশ্চিত করছি** (Yes, confirm) and **না, অর্ডার বাতিল করুন** (No, cancel). Links use a random 8-character code, expire after `CONFIRM_TTL_HOURS` (default 48), and stop accepting answers once the order leaves the awaiting state. For advance-payment orders the page shows the seller's bKash number, the fee and a reference code; the customer can cancel but not self-confirm — the seller confirms once the payment arrives.

## Message examples

These are the exact templates in `src/confirmation/messages.ts` (the code is the source of truth). The order number is left out on purpose: Bangla is sent as Unicode SMS (70 characters per single SMS, 67 per part when split), so every character costs money. The seller picks the language; the API reports segments per message.

| Case | Language | Template | Typical size |
|------|----------|----------|--------------|
| Confirm (medium risk) | Bangla (default) | `{shop}: ৳{amount} এর অর্ডারটি নিশ্চিত করুন: {link}` | 2 Unicode parts |
| Confirm | Banglish | `{shop}: Apnar Tk {amount} er order ti confirm korun: {link}` | 1 GSM SMS |
| Confirm | English | `{shop}: Please confirm your Tk {amount} cash-on-delivery order: {link}` | 1 GSM SMS |
| Advance (high risk) | Bangla | `{shop}: অর্ডার নিশ্চিত করতে ডেলিভারি চার্জ ৳{fee} অগ্রিম দিন: {link}` | 2 Unicode parts |
| Advance | Banglish | `{shop}: Order confirm korte delivery charge Tk {fee} advance din: {link}` | 1 GSM SMS |
| Advance | English | `{shop}: To confirm your order, please pay the Tk {fee} delivery charge in advance: {link}` | 1 GSM SMS |

`{shop}` is truncated to 20 characters; amounts in Bangla templates use Bangla digits. A reminder template (resend after N hours without an answer) is on the v0.2 roadmap; today the seller can resend manually with `POST /v1/orders/:id/resend`.

## Dashboard metrics

| Metric | Definition |
|--------|------------|
| RTO rate | returned ÷ (delivered + returned), per period, per courier, per district |
| Baseline RTO | seller's RTO rate in the 30 days before Nishchit (from import or onboarding interview) |
| Confirmation rate | confirmed ÷ confirmation requests sent |
| Cancelled before shipping | orders cancelled via the link: costs avoided entirely |
| Money saved (estimate) | (baseline RTO − current RTO) × shipped orders × cost per failed order (seller-set, default 150 BDT) |
| Risk distribution | share of orders by level |
| Response time | median time from SMS to customer reply |
| SMS sent and cost | for transparency and plan limits |

"Money saved" is an estimate and is labelled as one in the UI.

## Privacy rules (product-level)

- The shared network stores **HMAC-hashed phone numbers and outcome counts only**. Raw phone numbers and names stay within the seller's own account.
- No seller can see another seller's orders or customer details. Lookups return aggregate history and a score, never "who ordered what".
- The free Customer Checker requires a seller account and is rate-limited; it is not a public people-search tool.
- Sellers agree to share hashed outcomes in the Terms of Service; data is deleted on request.

## Non-goals

- Nishchit is **not a courier** and does not handle parcels.
- Nishchit is **not a payment processor**: advance payments go to the seller's own bKash; Nishchit does not hold customer money.
- Not a storefront or website builder.
- **No scraping** of courier merchant portals or use of seller courier logins to pull data.
- Not a public lookup service for individuals, and not a credit score for lending or any non-delivery purpose.
- No manual "bad customer" lists shared between sellers based on opinion; the network reflects delivery outcomes only.
