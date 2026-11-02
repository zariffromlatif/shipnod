# 08 — Launch kit: Facebook posts, replies and the DM sequence

Ready-to-paste Bangla copy for getting your first pilot sellers, from the first group post to the first payment. It builds on [06 — Sales playbook](06-sales-playbook.md) (demo script, objections, pilot terms) and the targets in [05 — Go-to-market](05-go-to-market.md).

Replace `YOURDOMAIN` with your domain and `{braces}` with real values. Keep every link's `?ref=` unique per group and post, so `/admin` → লিড shows which ones bring sellers.

---

## Before the first post

- [ ] Shipnod is live, `sms-test` arrives on your phone, and the Bangla SMS is readable.
- [ ] `LEAD_ALERT_PHONE` and `SUPPORT_WHATSAPP` are set. Submit the landing-page form once yourself and check that the SMS reaches you.
- [ ] **Decide the pilot terms, and only promise what you will honour.** The playbook's terms are a 14-day free pilot, no card, a money-back guarantee on the first paid month if returns don't fall below the agreed baseline, and free setup for the first 10 pilots in exchange for a testimonial. If you change any of these, change the posts too.
- [ ] Your test shop from the deployment guide works, so you can demo the SMS confirmation live on a call. **Never run `seed:demo` on the production server.** It writes fake sellers into the real shared delivery record.

### Launch-period honesty

At launch the shared delivery record is empty. It fills up as your sellers record what was delivered and what came back. So for the first weeks:

- **What works from day one:** SMS confirmation, the bKash advance for risky orders, flags for the same number ordering several times a day, incomplete addresses and unusually large orders, and one-click courier booking.
- **What grows with time:** "this number returned parcels before". Say *"যত বেশি ডেলিভারি, তত আগে ধরতে পারে"* (the more deliveries, the earlier it catches them). Never say "আমাদের কাছে সব ফ্রড নম্বর আছে" (we have every fraud number).
- **Don't promise a percentage drop** ("৫০% ফেরত কমবে") until pilots give you real numbers.
- **Don't post testimonials** or "results" you don't have. Use real ones only, with the seller's permission.
- **Don't sell voice-call confirmation or multiple users.** They aren't built yet.

---

## `?ref=` links

Pattern: `<channel>-<place>-<MMDD>`, lowercase, no spaces (letters, digits, `-` and `.` are kept).

| Where | Link |
|---|---|
| Post in "WE" group, 3 Nov | `https://YOURDOMAIN/?ref=fb-we-1103` |
| Post in another e-commerce group | `https://YOURDOMAIN/?ref=fb-<shortname>-<MMDD>` |
| Facebook DMs | `https://YOURDOMAIN/?ref=dm-fb` |
| WhatsApp messages | `https://YOURDOMAIN/?ref=wa` |
| Your own page / profile | `https://YOURDOMAIN/?ref=fb-own` |
| YouTube / reel description | `https://YOURDOMAIN/?ref=yt-<video>` |

---

## Post A: launch post (groups that allow promotion)

> **COD-তে ফেরত পার্সেল কমাতে চান? ১৪ দিন ফ্রিতে চেষ্টা করে দেখুন**
>
> মাসে কতগুলো পার্সেল ফেরত আসে, কখনো হিসাব করেছেন?
> ১,০০০ অর্ডারে ২৫% ফেরত মানে ২৫০টা পার্সেল। প্রতিটায় ডেলিভারি + রিটার্ন চার্জ + প্যাকেজিং মিলিয়ে ৳১৫০ ধরলেও মাসে ৳৩৭,৫০০ লস — বিজ্ঞাপনের খরচ বাদ দিয়েই।
>
> এই সমস্যার জন্য আমরা বানিয়েছি **Shipnod**:
> ✅ অর্ডার আসার সাথে সাথে ঝুঁকি যাচাই — একই নম্বরে একদিনে অনেক অর্ডার, অসম্পূর্ণ ঠিকানা, আগের ফেরতের রেকর্ড
> ✅ সন্দেহজনক অর্ডারে কাস্টমার নিজেই SMS লিংকে কনফার্ম বা বাতিল করেন — আপনাকে ফোন করতে হয় না
> ✅ যার ফেরতের রেকর্ড আছে, তার কাছে ডেলিভারি চার্জ আগে bKash-এ
> ✅ কনফার্ম হলে এক ক্লিকে Steadfast / Pathao / RedX বুকিং
>
> ফেসবুক পেজ, WooCommerce, Shopify — সব সেলারের জন্য। মোবাইল থেকেই চালানো যায়, পুরোটা বাংলায়।
>
> 🎁 **১৪ দিনের ফ্রি পাইলট** — কার্ড বা অগ্রিম লাগবে না, সেটআপ আমরা করে দেব।
> 👉 আবেদন: https://YOURDOMAIN/?ref=fb-GROUP-MMDD
>
> প্রশ্ন থাকলে কমেন্ট করুন, উত্তর দিচ্ছি।

**No-link version** (groups that remove links): replace the 👉 line with
> আগ্রহী হলে কমেন্টে লিখুন **"পাইলট"** — ইনবক্সে বিস্তারিত পাঠাচ্ছি।

**Vary the first line** for each group so Facebook doesn't treat repeats as spam:
- "রিটার্ন পার্সেলে মাসে কত টাকা যাচ্ছে, হিসাব করেছেন?"
- "ফেক অর্ডারে ক্লান্ত? শিপ করার আগেই ধরুন।"
- "কাস্টমারকে ফোন করে কনফার্ম করাতে দিনে কত ঘণ্টা যায়?"

## Post B: question post (strict groups, and the best way to find real numbers)

> সেলার ভাই-বোনেরা, একটা প্রশ্ন 🙏
>
> আপনাদের COD অর্ডারের মোটামুটি কত % ফেরত আসে? আর ফেরত কমাতে কী করেন — ফোন করে কনফার্ম, অগ্রিম নেওয়া, নাকি অন্য কিছু?
>
> আমি ফেরত পার্সেল কমানোর একটা টুল নিয়ে কাজ করছি, তাই সবার আসল অভিজ্ঞতা জানতে চাই। কমেন্টে লিখুন — কয়েকদিন পর সবার উত্তরের সারাংশ এখানেই শেয়ার করব।

There's no link and no pitch, so most groups allow it. The answers give you the two numbers the business plan still guesses at (return rate, and cost per returned parcel), and every commenter is a warm person to DM.

### Post B2: the promised summary (3–5 days later)

Only fill these in with real answers:

> গত সপ্তাহে জিজ্ঞেস করেছিলাম ফেরত পার্সেল নিয়ে — **{N} জন** সেলার উত্তর দিয়েছেন, সবাইকে ধন্যবাদ। যা জানলাম:
> • বেশিরভাগের ফেরত **{X}–{Y}%**
> • সবচেয়ে কাজের উপায়: **{top tactic}**
> • সবচেয়ে বড় ঝামেলা: **{biggest pain}**
>
> এই ঝামেলাগুলোর জন্যই আমরা Shipnod বানিয়েছি — সন্দেহজনক অর্ডারে কাস্টমার নিজেই SMS-এ কনফার্ম করেন, দরকারে অগ্রিম, তারপর এক ক্লিকে কুরিয়ার বুকিং। ১৪ দিন ফ্রি: https://YOURDOMAIN/?ref=fb-GROUP-MMDD

## Image for Post A (optional, 1080 × 1080, e.g. in Canva)

- **Big:** মাসে ৳৩৭,৫০০ লস?
- **Small:** ১,০০০ অর্ডার × ২৫% ফেরত × ৳১৫০
- **Bottom:** ফেরত কমান — Shipnod · ১৪ দিন ফ্রি

Plain dark text on a light background reads best in the feed. Don't use other brands' logos or courier logos.

---

## Replies to common comments

| They ask | Reply |
|---|---|
| দাম কত? | ১৪ দিন একদম ফ্রি। এরপর মাসে ৫০০ অর্ডার পর্যন্ত ৳৯৯০, ২,০০০ পর্যন্ত ৳২,৪৯০। একটা ফেরতে ৳১৫০ ধরলে মাসে ৭টা ফেরত ঠেকালেই ৳৯৯০ উঠে আসে। |
| কীভাবে কাজ করে? অর্ডার কীভাবে দেব? | ফেসবুক পেজের অর্ডার মোবাইল থেকে ৩০ সেকেন্ডে লিখে দেন — নাম, নম্বর, ঠিকানা, টাকা। WooCommerce/Shopify হলে অর্ডার নিজে থেকেই চলে আসে। তারপর Shipnod ঠিক করে: সরাসরি পাঠাবেন, SMS-এ কনফার্ম করাবেন, নাকি অগ্রিম নেবেন। |
| আমার তো ফ্রড চেকার আছে | চেকার শুধু নম্বরের রেকর্ড দেখায়, তারপর ফোন করা আর কনফার্ম করানো সব আপনাকেই করতে হয়। Shipnod কাস্টমারকে নিজে থেকে SMS-এ কনফার্ম করায়, দরকারে অগ্রিম চায়, তারপর কুরিয়ারে বুক করে — আর প্রতিটা ডেলিভারি থেকে শেখে। |
| কাস্টমারের তথ্য নিরাপদ? | অন্য কোনো সেলার আপনার কাস্টমারের নাম, নম্বর বা অর্ডার দেখতে পায় না। শেয়ার হয় শুধু নম্বরের একটা গোপন কোড আর কতগুলো পার্সেল ডেলিভারি বা ফেরত হয়েছে সেই সংখ্যা। |
| কাস্টমার SMS পেয়ে বিরক্ত হবে না? | ভালো রেকর্ডের কাস্টমার কোনো SMS-ই পান না। বাকিরা একটা ছোট SMS পান, এক ট্যাপে কনফার্ম — "আমি অর্ডার করিনি" ঝামেলাও কমে। |
| কোন কুরিয়ার? | Steadfast, Pathao, RedX-এ এক ক্লিকে বুকিং। অন্য কুরিয়ার হলেও ঝুঁকি যাচাই আর SMS কনফার্মেশন কাজ করবে — ডেলিভারি হলো কি না শুধু এক ট্যাপে লিখে দেবেন। |
| SMS-এর খরচ আলাদা? | না, প্ল্যানের মধ্যেই ধরা আছে। |
| নতুন কোম্পানি, বিশ্বাস করব কেন? | একদম ঠিক প্রশ্ন। তাই ১৪ দিন ফ্রি — কোনো টাকা না দিয়ে নিজের পেজে দেখে নিন। পছন্দ না হলে কিছুই দিতে হবে না। |
| "পাইলট" | ধন্যবাদ! ইনবক্স চেক করুন 🙂 *(then send DM 1 below)* |

---

## The DM sequence

### 1. To everyone who commented (same day)

> আসসালামু আলাইকুম {নাম}, পোস্টে কমেন্টের জন্য ধন্যবাদ।
> আপনার পেজে মাসে মোটামুটি কতগুলো COD অর্ডার হয়, আর কত % ফেরত আসে?
> চাইলে ১০ মিনিটের একটা কলে আপনার পেজের হিসাবটা দেখিয়ে দিই, আর আজই ১৪ দিনের ফ্রি পাইলট চালু করে দিই।
> বিস্তারিত আর আবেদন: https://YOURDOMAIN/?ref=dm-fb

### 2. One follow-up only, 2–3 days later

Use the follow-up in the [sales playbook](06-sales-playbook.md#follow-up-once-23-days-later--bangla). Never send a second one.

### 3. When someone fills in the form

1. Call within 24 hours from `/admin` → লিড → **ফোন করুন**. Run the demo script from the playbook.
2. No answer? Tap **WhatsApp**: the greeting is already typed.
3. Still nothing after a day:
   > আপনাকে ফোনে পাইনি 🙂 কখন কথা বললে সুবিধা — আজ সন্ধ্যা না কাল সকাল?

### 4. Pilot day 0, right after **বিক্রেতা বানান**

> অভিনন্দন! আপনার Shipnod চালু হয়েছে — SMS-এ লগইন লিংক গেছে।
> আজ শুধু একটা কাজ: আজকের অর্ডারগুলো **"+ নতুন অর্ডার"** দিয়ে দিন। প্রথমটা নিজের আরেকটা নম্বর দিয়ে দিন, দেখবেন কাস্টমার কী SMS পান।
> আর আগের ৩০ দিনে কতগুলো পার্সেল ফেরত এসেছিল, কুরিয়ার প্যানেল দেখে জানাবেন? পাইলট শেষে সেটার সাথে মিলিয়ে দেখব।

Write their 30-day return number down. That's the baseline for the money-back promise.

### 5. Day 3 check-in

> কেমন চলছে? কতগুলো অর্ডার দিলেন, কেউ কি SMS-এ বাতিল করেছে? কোথাও আটকালে বলুন, ৫ মিনিটে ঠিক করে দিচ্ছি।
> আর পার্সেল ডেলিভারি বা ফেরত হলে অর্ডারে এক ট্যাপে লিখে দেবেন — এতে Shipnod আপনার কাস্টমারদের চিনতে শেখে।

### 6. Day 10: before the pilot ends

Their renewal SMS start automatically 5 days before the end. Send this personal message first, with the numbers from their ওভারভিউ (overview) page:

> {নাম}, আপনার পাইলটের ১০ দিন হলো। ড্যাশবোর্ড বলছে **{X}টা অর্ডার শিপিংয়ের আগেই থেমেছে** — আনুমানিক **৳{Y}** বাঁচল।
> পাইলট শেষ হবে **{তারিখ}**। চালু রাখতে ড্যাশবোর্ডের **"বিলিং"**-এ প্ল্যান নিন — bKash বা Nagad-এ পেমেন্ট করা যায়। আপনার অর্ডার অনুযায়ী **{প্ল্যান}** ঠিক হবে (৳{দাম}/মাস)।

If their numbers are weak, ask what went wrong before asking for money. Extend their pilot from `/admin` (set plan → days) if they barely used it.

### 7. After their first payment

> ধন্যবাদ! একটা অনুরোধ: আপনার অভিজ্ঞতা দুই লাইনে লিখে দিলে — আপনার অনুমতি নিয়ে, নাম আর পেজসহ — অন্য সেলারদের দেখাতে পারি। আর পরিচিত কোনো সেলার ফেরত পার্সেল নিয়ে ঝামেলায় থাকলে তাঁর সাথে পরিচয় করিয়ে দিলে খুব উপকার হয় 🙏

Real testimonials become your strongest next post: "{পেজের নাম}-এ পাইলটের ১৪ দিনে {X}টা ফেক অর্ডার শিপিংয়ের আগেই ধরা পড়েছে…"

---

## Posting rules

- **Read each group's rules.** Many allow promotion only on certain days. Use Post B everywhere else.
- **Pace yourself:** 2–3 groups a day at most, a different first line and `?ref=` each time.
- **Timing:** try evenings, when many sellers are handling orders (8–11 pm is a guess), and compare the refs in `/admin` → লিড.
- **Be fast:** reply to every comment within an hour and DM every commenter the same day. Speed wins more pilots than copy does.
- **Measure weekly:** posts → comments → DMs → requests (by ref) → pilots → paid. That's the funnel in [05 — Go-to-market](05-go-to-market.md). After the first 100 DMs, replace its guessed rates with yours.
