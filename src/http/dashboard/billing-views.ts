import { html, raw } from 'hono/html';
import { planOf, type Plan, type PlanId } from '../../billing/plans.js';
import type { Cycle, SubscriptionState } from '../../billing/subscription.js';
import type { Invoice, Payment } from '../../db/billing-repo.js';
import type { Seller } from '../../db/store.js';
import type { Quote } from '../../services/billing.js';
import { csrfField, dateTime, flash, num, page, taka, type Html } from './ui.js';

const DATE = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric' });
const date = (d: Date | string) => DATE.format(new Date(d));

export const BILLING_MESSAGES: Record<string, string> = {
  created: 'ইনভয়েস তৈরি হয়েছে। নিচে থেকে পেমেন্ট করুন।',
  paid: 'পেমেন্ট সফল — আপনার প্ল্যান চালু হয়েছে। ধন্যবাদ!',
  review: 'পেমেন্ট পাওয়া গেছে, যাচাই চলছে। যাচাই হলে SMS পাবেন।',
  submitted: 'ধন্যবাদ! আপনার পেমেন্ট যাচাই করা হচ্ছে — সাধারণত কয়েক ঘণ্টার মধ্যে। যাচাই হলে SMS পাবেন।',
  failed: 'পেমেন্ট সম্পন্ন হয়নি। আবার চেষ্টা করুন অথবা অন্য পদ্ধতি বেছে নিন।',
  cancelled: 'পেমেন্ট বাতিল করা হয়েছে।',
  unknown: 'পেমেন্টের অবস্থা এখনো নিশ্চিত নয়। কয়েক মিনিট পর পাতাটি রিফ্রেশ করুন।',
};

const STATUS_TEXT: Record<Invoice['status'], string> = { open: 'বাকি', paid: 'পরিশোধিত', void: 'বাতিল' };
const METHOD_TEXT: Record<string, string> = { sslcommerz: 'অনলাইন (SSLCommerz)', bkash: 'bKash', nagad: 'Nagad', credit: 'অ্যাকাউন্ট ক্রেডিট' };
const PAYMENT_STATUS_TEXT: Record<Payment['status'], string> = {
  initiated: 'শুরু হয়েছে',
  pending_review: 'যাচাই চলছে',
  succeeded: 'সফল',
  failed: 'ব্যর্থ',
  rejected: 'বাতিল (যাচাই হয়নি)',
};
const cycleText = (c: Cycle) => (c === 'annual' ? 'বাৎসরিক' : 'মাসিক');

function statusCard(seller: Seller, state: SubscriptionState, effective: Plan): Html {
  const purchased = planOf(state.purchasedPlan);
  let line: Html;
  switch (state.status) {
    case 'free':
      line = html`আপনি <strong>Free</strong> প্ল্যানে আছেন — শুধু কাস্টমার চেক। অর্ডার অটোমেশনের জন্য একটি প্ল্যান নিন।`;
      break;
    case 'comped':
      line = html`<strong>${purchased.name}</strong> প্ল্যান চালু আছে (Shipnod টিম চালু করেছে, মেয়াদ নেই)।`;
      break;
    case 'active':
      line = html`<strong>${purchased.name}</strong> প্ল্যান · ${date(state.paidUntil!)} পর্যন্ত · আর ${num(state.daysLeft ?? 0)} দিন`;
      break;
    case 'grace':
      line = html`<strong>${purchased.name}</strong> প্ল্যানের মেয়াদ শেষ হয়েছে ${date(state.paidUntil!)}। ${date(state.graceEndsAt!)} পর্যন্ত সব চালু থাকবে।`;
      break;
    case 'expired':
      line = html`মেয়াদ শেষ — এখন <strong>Free</strong> প্ল্যান (${purchased.name} শেষ হয়েছে ${date(state.paidUntil!)})।`;
      break;
  }
  return html`<div class="card">
    <h2>বর্তমান প্ল্যান</h2>
    <p>${line}</p>
    <p class="muted small">এখন চালু সীমা: মাসে ${num(effective.monthlyOrders)}টি অর্ডার · ${num(effective.monthlyRiskChecks)}টি কাস্টমার চেক${seller.creditBdt > 0 ? html` · অ্যাকাউন্ট ক্রেডিট ${taka(seller.creditBdt)}` : ''}</p>
  </div>`;
}

const PLAN_FEATURES: Record<Exclude<PlanId, 'free'>, string[]> = {
  starter: ['মাসে ৫০০ অর্ডার', 'SMS কনফার্মেশন ও অগ্রিম', '১টি কুরিয়ার'],
  growth: ['মাসে ২,০০০ অর্ডার', 'সব কুরিয়ার', 'WooCommerce / Shopify', 'নিজের ঝুঁকি-নিয়ম'],
  scale: ['মাসে ৬,০০০ অর্ডার', 'সব কুরিয়ার ও ইন্টিগ্রেশন', 'ভয়েস কনফার্মেশন*', 'একাধিক ইউজার*'],
};

export function billingPage(d: {
  seller: Seller;
  now?: Date;
  csrf: string;
  state: SubscriptionState;
  effectivePlan: Plan;
  cycle: Cycle;
  quotes: Quote[];
  invoices: Invoice[];
  message?: string;
  error?: string;
}): Html {
  const current = d.state.status === 'active' || d.state.status === 'grace' || d.state.status === 'comped' ? d.state.purchasedPlan : 'free';
  const rank = (p: PlanId) => ['free', 'starter', 'growth', 'scale'].indexOf(p);
  return page({
    title: 'বিলিং',
    active: 'billing',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <h1>বিলিং</h1>
      ${flash('ok', d.message)} ${flash('error', d.error)}
      ${statusCard(d.seller, d.state, d.effectivePlan)}

      <div class="actions" style="justify-content:space-between;align-items:center;margin-top:18px">
        <h2 style="margin:0">প্ল্যান বেছে নিন</h2>
        <nav class="tabs" style="margin:0" aria-label="বিলিং সাইকেল">
          <a href="/app/billing?cycle=monthly" ${d.cycle === 'monthly' ? raw('aria-current="page"') : ''}>মাসিক</a>
          <a href="/app/billing?cycle=annual" ${d.cycle === 'annual' ? raw('aria-current="page"') : ''}>বাৎসরিক — ২ মাস ফ্রি</a>
        </nav>
      </div>
      <div class="grid" style="margin-top:12px">
        ${d.quotes.map((q) => {
          const plan = planOf(q.plan);
          const action = q.plan === current ? 'রিনিউ করুন' : rank(q.plan) > rank(current) ? 'আপগ্রেড করুন' : 'এই প্ল্যানে যান';
          const notes: string[] = [];
          if (q.prorationCreditBdt > 0) notes.push(`বর্তমান প্ল্যানের বাকি দিনের ${taka(q.prorationCreditBdt)} বাদ`);
          if (q.balanceCreditBdt > 0) notes.push(`ক্রেডিট ${taka(q.balanceCreditBdt)} বাদ`);
          const overage = q.lines.filter((l) => l.kind === 'overage').reduce((n, l) => n + l.amountBdt, 0);
          if (overage > 0) notes.push(`আগের মাসের অতিরিক্ত অর্ডার ${taka(overage)} যোগ`);
          return html`<form class="tile" method="post" action="/app/billing" ${q.plan === current ? raw('style="border-color:var(--ink)"') : ''}>
            ${csrfField(d.csrf)}<input type="hidden" name="op" value="create"><input type="hidden" name="plan" value="${q.plan}"><input type="hidden" name="cycle" value="${q.cycle}">
            <p class="tile-label">${plan.name}${q.plan === current ? ' · বর্তমান' : ''}</p>
            <p class="tile-value">${taka(q.lines[0]!.amountBdt)}<span class="muted small">/${q.cycle === 'annual' ? 'বছর' : 'মাস'}</span></p>
            <ul class="small muted" style="padding-left:18px;margin:8px 0">${PLAN_FEATURES[q.plan as Exclude<PlanId, 'free'>].map((f) => html`<li>${f}</li>`)}</ul>
            ${notes.length ? html`<p class="small">আজ দেবেন <strong>${taka(q.totalBdt)}</strong><br><span class="muted">${notes.join(' · ')}</span></p>` : ''}
            <p class="muted small">${date(q.paidUntil)} পর্যন্ত চলবে</p>
            <button class="${q.plan === current || rank(q.plan) > rank(current) ? 'primary' : ''}" type="submit">${action}</button>
          </form>`;
        })}
      </div>
      <p class="muted small">মাসিক = ৩০ দিন, বাৎসরিক = ৩৬৫ দিন। প্ল্যানের সীমার বেশি অর্ডার হলে প্রতি অর্ডারে ৳১.৫, পরের ইনভয়েসে যোগ হয়। আপগ্রেড করলে বর্তমান প্ল্যানের বাকি দিনের টাকা বাদ যায়। *Scale-এর ভয়েস ও মাল্টি-ইউজার শিগগিরই আসছে।</p>

      <div class="card">
        <h2>ইনভয়েস</h2>
        ${d.invoices.length === 0
          ? html`<p class="muted">এখনো কোনো ইনভয়েস নেই।</p>`
          : html`<table><thead><tr><th>নম্বর</th><th>তারিখ</th><th>প্ল্যান</th><th style="text-align:right">মোট</th><th>অবস্থা</th></tr></thead><tbody>
              ${d.invoices.map(
                (i) => html`<tr><td><a href="/app/billing/invoices/${i.id}">${i.number}</a></td><td>${dateTime(i.createdAt)}</td>
                  <td>${planOf(i.plan).name} · ${cycleText(i.cycle)}</td><td style="text-align:right">${taka(i.totalBdt)}</td><td>${STATUS_TEXT[i.status]}</td></tr>`,
              )}</tbody></table>`}
      </div>`,
  });
}

export function invoicePage(d: {
  seller: Seller;
  now?: Date;
  csrf: string;
  invoice: Invoice;
  payments: Payment[];
  payable: boolean;
  paidUntilIfPaidNow: Date;
  options: { online: boolean; bkash: string | null; nagad: string | null };
  message?: string;
  error?: string;
  form?: { method?: string; payerPhone?: string; reference?: string };
}): Html {
  const i = d.invoice;
  const pending = d.payments.find((p) => p.status === 'pending_review');
  const manualMethods = (['bkash', 'nagad'] as const).filter((m) => d.options[m]);
  const action = `/app/billing/invoices/${i.id}`;
  const f = d.form ?? {};

  let payBlock: Html | string = '';
  if (i.status === 'paid') {
    payBlock = html`<div class="card"><p class="status"><span aria-hidden="true">✓ </span>পরিশোধিত ${i.paidAt ? dateTime(i.paidAt) : ''} · ${METHOD_TEXT[i.paymentMethod ?? ''] ?? ''}</p>
      <p class="muted small">এটি আপনার রসিদ। প্রিন্ট বা PDF করতে ব্রাউজারের Print ব্যবহার করুন।</p></div>`;
  } else if (pending) {
    payBlock = html`<div class="card"><h2>যাচাই চলছে</h2><p>আপনার ${METHOD_TEXT[pending.method]} পেমেন্ট${pending.reference ? html` (TrxID <code>${pending.reference}</code>)` : ''} যাচাই করা হচ্ছে। যাচাই হলে SMS পাবেন এবং প্ল্যান নিজে থেকেই চালু হবে।</p></div>`;
  } else if (!d.payable) {
    payBlock = html`<div class="card"><p>এই ইনভয়েসের মেয়াদ শেষ বা বাতিল হয়েছে। <a href="/app/billing">বিলিং পাতা থেকে নতুন করে প্ল্যান বেছে নিন</a>।</p></div>`;
  } else if (i.totalBdt === 0) {
    payBlock = html`<form class="card" method="post" action="${action}">${csrfField(d.csrf)}<input type="hidden" name="op" value="credit">
      <h2>ক্রেডিট দিয়ে চালু করুন</h2><p class="muted">পুরো টাকা আপনার ক্রেডিট থেকে কাটা হবে।</p>
      <button class="primary" type="submit">প্ল্যান চালু করুন</button></form>`;
  } else {
    const blocks: Html[] = [];
    if (d.options.online) {
      blocks.push(html`<form class="card" method="post" action="${action}">${csrfField(d.csrf)}<input type="hidden" name="op" value="online">
        <h2>অনলাইনে পেমেন্ট</h2><p class="muted small">bKash, Nagad, Rocket, কার্ড বা ইন্টারনেট ব্যাংকিং — SSLCommerz-এর নিরাপদ পাতায়।</p>
        <button class="primary" type="submit">${taka(i.totalBdt)} পেমেন্ট করুন</button></form>`);
    }
    if (manualMethods.length > 0) {
      blocks.push(html`<form class="card" method="post" action="${action}">${csrfField(d.csrf)}<input type="hidden" name="op" value="manual">
        <h2>Send Money করে পেমেন্ট</h2>
        <ol class="small" style="padding-left:18px">
          ${manualMethods.map((m) => html`<li>${m === 'bkash' ? 'bKash' : 'Nagad'}: <strong>${d.options[m]}</strong> নম্বরে <strong>${taka(i.totalBdt)}</strong> Send Money করুন। রেফারেন্সে লিখুন <strong style="white-space:nowrap">${i.number}</strong></li>`)}
          <li>মেসেজে আসা Transaction ID (TrxID) নিচে দিন।</li>
        </ol>
        ${manualMethods.length > 1
          ? html`<label>কোথা থেকে পাঠালেন</label>${manualMethods.map((m) => html`<label class="check"><input type="radio" name="method" value="${m}" ${(f.method ?? 'bkash') === m ? raw('checked') : ''}>${m === 'bkash' ? 'bKash' : 'Nagad'}</label>`)}`
          : html`<input type="hidden" name="method" value="${manualMethods[0]}">`}
        <div class="fields">
          <div><label for="payerPhone">যে নম্বর থেকে পাঠিয়েছেন</label><input id="payerPhone" name="payerPhone" type="tel" inputmode="tel" required value="${f.payerPhone ?? d.seller.phone ?? ''}"></div>
          <div><label for="reference">Transaction ID (TrxID)</label><input id="reference" name="reference" required maxlength="20" autocomplete="off" style="text-transform:uppercase" value="${f.reference ?? ''}" placeholder="যেমন 9JK3L2M4N5"></div>
        </div>
        <button type="submit">যাচাইয়ের জন্য জমা দিন</button></form>`);
    }
    payBlock = blocks.length
      ? html`<div class="cols">${blocks}</div>`
      : html`<div class="card"><p>পেমেন্ট নেওয়া এখনো চালু হয়নি। প্ল্যান চালু করতে Shipnod টিমের সাথে যোগাযোগ করুন।</p></div>`;
  }

  return page({
    title: `ইনভয়েস ${i.number}`,
    active: 'billing',
    seller: d.seller,
    csrf: d.csrf,
    now: d.now,
    body: html`
      <p class="small"><a href="/app/billing">← বিলিং</a></p>
      <div class="actions" style="justify-content:space-between;align-items:center"><h1>ইনভয়েস ${i.number}</h1><span class="chip">${STATUS_TEXT[i.status]}</span></div>
      ${flash('ok', d.message)} ${flash('error', d.error)}
      <div class="card">
        <dl class="kv">
          <dt>দোকান</dt><dd>${d.seller.shopName}</dd>
          <dt>তারিখ</dt><dd>${dateTime(i.createdAt)}</dd>
          <dt>প্ল্যান</dt><dd>${planOf(i.plan).name} · ${cycleText(i.cycle)}</dd>
          ${i.status === 'open' ? html`<dt>মেয়াদ</dt><dd>${dateTime(i.expiresAt)} পর্যন্ত পেমেন্ট করা যাবে · এখন দিলে প্ল্যান চলবে ${date(d.paidUntilIfPaidNow)} পর্যন্ত</dd>` : ''}
        </dl>
        <table style="margin-top:12px"><tbody>
          ${i.lines.map((l) => html`<tr><td>${l.description}</td><td style="text-align:right">${taka(l.amountBdt)}</td></tr>`)}
          ${i.creditAppliedBdt > 0 ? html`<tr><td>ক্রেডিট বাদ${i.prorationCreditBdt > 0 ? ' (বর্তমান প্ল্যানের বাকি দিন সহ)' : ''}</td><td style="text-align:right">−${taka(i.creditAppliedBdt)}</td></tr>` : ''}
          <tr><td><strong>মোট</strong></td><td style="text-align:right"><strong>${taka(i.totalBdt)}</strong></td></tr>
        </tbody></table>
      </div>
      ${payBlock}
      ${d.payments.length > 0
        ? html`<div class="card"><h2>পেমেন্টের চেষ্টা</h2><table><tbody>${d.payments.map(
            (p) => html`<tr><td>${dateTime(p.createdAt)}</td><td>${METHOD_TEXT[p.method]}</td><td>${p.reference ?? ''}</td><td>${taka(p.amountBdt)}</td><td>${PAYMENT_STATUS_TEXT[p.status]}</td></tr>`,
          )}</tbody></table></div>`
        : ''}`,
  });
}
