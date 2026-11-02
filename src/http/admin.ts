import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import { z } from 'zod';
import { PLAN_IDS, planOf } from '../billing/plans.js';
import type { BillingRepo } from '../db/billing-repo.js';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { subscriptionState } from '../billing/subscription.js';
import { toE164 } from '../domain/phone.js';
import type { BillingService } from '../services/billing.js';
import type { OnboardingService, OnboardResult } from '../services/onboarding.js';
import { LEAD_STATUSES, type Lead, type LeadStatus } from '../db/leads-repo.js';
import type { LeadService } from '../services/leads.js';
import { ago, csrfField, dateTime, flash, num, shell, taka, type Html } from './dashboard/ui.js';

/**
 * Founder/admin console at /admin: approve manual bKash/Nagad payments, comp plans for pilots,
 * and watch MRR. Enabled only when ADMIN_PASSWORD is set.
 */
const COOKIE = 'shipnod_admin';
const SESSION_HOURS = 12;
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

type AdminEnv = { Variables: { session: string; csrf: string } };

export interface AdminOptions {
  password: string;
  secureCookies: boolean;
  now?: () => Date;
}

const STATUS_TEXT: Record<string, string> = {
  free: 'Free',
  comped: 'চালু (মেয়াদ নেই)',
  active: 'চালু',
  grace: 'গ্রেস পিরিয়ড',
  expired: 'মেয়াদ শেষ',
};

function adminPage(title: string, csrf: string | null, body: Html): Html {
  return shell(
    title,
    html`<header class="top"><div class="top-in">
        <a class="brand" href="/admin">Shipnod<small>অ্যাডমিন</small></a>
        ${csrf
          ? html`<nav aria-label="অ্যাডমিন মেনু"><a href="/admin">ওভারভিউ</a><a href="/admin/leads">লিড</a><a href="/admin/sellers/new">+ নতুন বিক্রেতা</a></nav>
              <form class="inline" method="post" action="/admin/logout">${csrfField(csrf)}<button type="submit">লগআউট</button></form>`
          : ''}
      </div></header>
      <main>${body}</main>`,
  );
}

function loginView(error?: string): Html {
  return adminPage(
    'অ্যাডমিন লগইন',
    null,
    html`<div class="card" style="max-width:400px;margin:8vh auto 0">
      <h1>অ্যাডমিন লগইন</h1>${flash('error', error)}
      <form method="post" action="/admin/login"><label for="password">পাসওয়ার্ড</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" autofocus>
        <button class="primary" type="submit">লগইন</button></form>
    </div>`,
  );
}

export interface AdminDeps {
  billing: BillingService;
  repo: BillingRepo;
  onboarding: OnboardingService;
  leads: LeadService;
}

export interface NewSellerValues {
  /** Set when signing up a seller from a pilot request; the lead is marked converted. */
  leadId?: string;
  name?: string;
  shopName?: string;
  phone?: string;
  plan?: string;
  trialDays?: string;
  smsLang?: string;
  sendWelcome?: boolean;
}

const LONG_DATE = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric' });

function newSellerView(csrf: string, v: NewSellerValues = {}, error?: string): Html {
  const plan = v.plan ?? 'growth';
  const lang = v.smsLang ?? 'bn';
  const welcome = v.sendWelcome ?? true;
  return adminPage(
    'নতুন বিক্রেতা',
    csrf,
    html`<h1>নতুন বিক্রেতা</h1>
      ${v.leadId ? html`<p class="small">পাইলট আবেদন থেকে — যোগ করলে লিডটি "বিক্রেতা হয়েছে" হিসেবে চিহ্নিত হবে।</p>` : ''}
      <p class="muted">বিক্রেতা এই মোবাইল নম্বর দিয়ে SMS কোডে লগইন করবেন — পাসওয়ার্ড লাগবে না।</p>
      ${flash('error', error)}
      <form class="card" method="post" action="/admin/sellers">
        ${csrfField(csrf)}${v.leadId ? html`<input type="hidden" name="leadId" value="${v.leadId}">` : ''}
        <div class="fields">
          <div><label for="name">মালিকের নাম</label><input id="name" name="name" required maxlength="80" value="${v.name ?? ''}" autocomplete="off"></div>
          <div><label for="shopName">দোকানের নাম (SMS-এ দেখাবে)</label><input id="shopName" name="shopName" required maxlength="60" value="${v.shopName ?? ''}" autocomplete="off"></div>
          <div><label for="phone">মোবাইল নম্বর</label><input id="phone" name="phone" type="tel" inputmode="tel" required value="${v.phone ?? ''}" placeholder="01XXXXXXXXX" autocomplete="off"></div>
        </div>
        <div class="fields">
          <div><label for="plan">প্ল্যান</label>
            <select id="plan" name="plan">${PLAN_IDS.map((p) => html`<option value="${p}" ${p === plan ? raw('selected') : ''}>${planOf(p).name}${planOf(p).priceBdt ? ` · ৳${num(planOf(p).priceBdt)}/মাস` : ''}</option>`)}</select></div>
          <div><label for="trialDays">পাইলট (দিন)</label><input id="trialDays" name="trialDays" inputmode="numeric" value="${v.trialDays ?? '14'}">
            <p class="muted small">খালি রাখলে মেয়াদ থাকবে না। মেয়াদ শেষে বিক্রেতা রিনিউ SMS পাবেন।</p></div>
          <div><label for="smsLang">কাস্টমারকে SMS-এর ভাষা</label>
            <select id="smsLang" name="smsLang">${[['bn', 'বাংলা'], ['banglish', 'Banglish'], ['en', 'English']].map(([id, label]) => html`<option value="${id}" ${id === lang ? raw('selected') : ''}>${label}</option>`)}</select></div>
        </div>
        <label class="check"><input type="checkbox" name="sendWelcome" value="1" ${welcome ? raw('checked') : ''}>এখনই বিক্রেতাকে লগইন লিংক SMS করুন</label>
        <button class="primary" type="submit">বিক্রেতা যোগ করুন</button>
      </form>`,
  );
}

function createdView(csrf: string, r: OnboardResult, now: Date): Html {
  const s = r.seller;
  const state = subscriptionState(s, now);
  const planLine =
    state.status === 'free'
      ? 'Free (শুধু কাস্টমার চেক)'
      : state.paidUntil
        ? `${planOf(s.plan).name} · পাইলট ${LONG_DATE.format(state.paidUntil)} পর্যন্ত`
        : `${planOf(s.plan).name} · মেয়াদ নেই`;
  const wa = `https://wa.me/${toE164(s.phone!).slice(1)}?text=${encodeURIComponent(r.welcome.text)}`;
  const copyable = (id: string, value: string) =>
    html`<input id="${id}" readonly value="${value}" onfocus="this.select()" style="font-family:ui-monospace,monospace">`;
  return adminPage(
    'বিক্রেতা যোগ হয়েছে',
    csrf,
    html`<h1>${s.shopName}</h1>
      ${flash('ok', 'বিক্রেতা যোগ হয়েছে।')}
      ${r.welcome.sent ? flash('ok', `লগইন লিংক ${s.phone} নম্বরে SMS করা হয়েছে।`) : ''}
      ${r.welcome.error ? flash('error', `SMS যায়নি: ${r.welcome.error} — নিচের WhatsApp বা লিংক দিয়ে পাঠান।`) : ''}
      <div class="card">
        <dl class="kv">
          <dt>মালিক</dt><dd>${s.name}</dd>
          <dt>মোবাইল</dt><dd>${s.phone}</dd>
          <dt>প্ল্যান</dt><dd>${planLine}</dd>
          <dt>আইডি</dt><dd><code>${s.id}</code></dd>
        </dl>
      </div>
      <div class="card">
        <h2>বিক্রেতাকে পাঠান</h2>
        <label for="login">লগইন লিংক (এই নম্বর দিয়ে লগইন করবেন)</label>${copyable('login', r.loginUrl)}
        <div class="actions"><a class="btn primary" href="${wa}" target="_blank" rel="noopener">WhatsApp-এ পাঠান</a></div>
      </div>
      <div class="card">
        <h2>API key</h2>
        <p class="small"><strong>শুধু এখনই দেখা যাবে।</strong> নিজের সিস্টেম বা API দিয়ে অর্ডার পাঠাতে চাইলেই লাগবে — ড্যাশবোর্ড ব্যবহারে লাগে না। WooCommerce/Shopify-এর ওয়েবহুক তথ্য বিক্রেতার সেটিংস পাতায় আছে।</p>
        ${copyable('apikey', r.apiKey)}
      </div>
      <div class="actions"><a class="btn primary" href="/admin/sellers/new">+ আরেকজন যোগ করুন</a><a class="btn" href="/admin">ওভারভিউ</a></div>`,
  );
}

const ORDERS_TEXT: Record<string, string> = { '<300': '৩০০-এর কম', '300-1000': '৩০০–১,০০০', '1000-3000': '১,০০০–৩,০০০', '3000+': '৩,০০০+' };
const CHANNEL_TEXT: Record<string, string> = { facebook: 'ফেসবুক পেজ', website: 'ওয়েবসাইট', both: 'ফেসবুক + ওয়েবসাইট' };
const COURIER_TEXT: Record<string, string> = { steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX', other: 'অন্যান্য' };
const LEAD_STATUS_TEXT: Record<LeadStatus, string> = { new: 'নতুন', contacted: 'যোগাযোগ হয়েছে', converted: 'বিক্রেতা হয়েছে', lost: 'বাদ' };

/** Plan that fits the order volume a lead reported. */
function suggestedPlan(lead: Lead): string {
  if (lead.monthlyOrders === '<300') return 'starter';
  if (lead.monthlyOrders === '3000+') return 'scale';
  return 'growth';
}

function leadsView(
  csrf: string,
  d: { leads: Lead[]; status: LeadStatus | 'all'; counts: Record<LeadStatus, number>; whatsapp: (l: Lead) => string; now: Date; message?: string },
): Html {
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const tabs: Array<[LeadStatus | 'all', string, number]> = [
    ...LEAD_STATUSES.map((s): [LeadStatus, string, number] => [s, LEAD_STATUS_TEXT[s], d.counts[s]]),
    ['all', 'সব', total],
  ];
  const statusButton = (l: Lead, to: LeadStatus, label: string, cls = '') =>
    html`<form class="inline" method="post" action="/admin/leads/${l.id}">${csrfField(csrf)}<input type="hidden" name="status" value="${to}"><input type="hidden" name="back" value="${d.status}"><button class="${cls}" type="submit" style="margin:0">${label}</button></form>`;
  return adminPage(
    'লিড',
    csrf,
    html`<h1>পাইলট আবেদন</h1>
      <p class="muted">ল্যান্ডিং পেজের ফর্ম থেকে আসা আবেদন। ফোন বা WhatsApp করুন, তারপর "বিক্রেতা বানান"।</p>
      ${flash('ok', d.message)}
      <nav class="tabs" aria-label="লিডের অবস্থা">${tabs.map(
        ([key, label, n]) => html`<a href="/admin/leads?status=${key}" ${key === d.status ? raw('aria-current="page"') : ''}>${label} (${num(n)})</a>`,
      )}</nav>
      ${d.leads.length === 0
        ? html`<div class="card"><p class="empty">এখানে কোনো আবেদন নেই।</p></div>`
        : d.leads.map(
            (l) => html`<div class="card">
              <div class="actions" style="justify-content:space-between;align-items:center;margin:0">
                <h2 style="margin:0">${l.shopName}</h2><span class="chip">${LEAD_STATUS_TEXT[l.status]}</span>
              </div>
              <dl class="kv" style="margin-top:10px">
                <dt>নাম</dt><dd>${l.name}</dd>
                <dt>মোবাইল</dt><dd><a href="tel:${l.phone}">${l.phone}</a></dd>
                <dt>অর্ডার/মাস</dt><dd>${l.monthlyOrders ? ORDERS_TEXT[l.monthlyOrders] : '—'}</dd>
                <dt>বিক্রি</dt><dd>${l.channel ? CHANNEL_TEXT[l.channel] : '—'}</dd>
                <dt>কুরিয়ার</dt><dd>${l.couriers.length ? l.couriers.map((c) => COURIER_TEXT[c] ?? c).join(', ') : '—'}</dd>
                ${l.source ? html`<dt>সোর্স</dt><dd><code>${l.source}</code></dd>` : ''}
                <dt>সময়</dt><dd>${ago(l.createdAt, d.now)}</dd>
                ${l.sellerId ? html`<dt>বিক্রেতা</dt><dd><code>${l.sellerId}</code></dd>` : ''}
              </dl>
              <div class="actions">
                <a class="btn" href="tel:${l.phone}" style="margin:0">ফোন করুন</a>
                <a class="btn" href="${d.whatsapp(l)}" target="_blank" rel="noopener" style="margin:0">WhatsApp</a>
                ${l.status !== 'converted' ? html`<a class="btn primary" href="/admin/sellers/new?lead=${l.id}" style="margin:0">বিক্রেতা বানান</a>` : ''}
                ${l.status === 'new' ? statusButton(l, 'contacted', 'যোগাযোগ হয়েছে') : ''}
                ${l.status === 'new' || l.status === 'contacted' ? statusButton(l, 'lost', 'বাদ দিন', 'danger') : ''}
                ${l.status === 'lost' ? statusButton(l, 'new', 'আবার খুলুন') : ''}
              </div>
            </div>`,
          )}`,
  );
}

const ONBOARD_ERRORS: Record<string, string> = {
  invalid_name: 'মালিকের নাম দিন (৮০ অক্ষরের মধ্যে)।',
  invalid_shop: 'দোকানের নাম দিন (৬০ অক্ষরের মধ্যে)।',
  invalid_phone: 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন।',
  phone_taken: 'এই নম্বরে আগেই একজন বিক্রেতা আছে। ওভারভিউ-এর বিক্রেতা তালিকায় দেখুন।',
  invalid_days: 'পাইলটের দিন ১ থেকে ৩৬৫-এর মধ্যে দিন, অথবা খালি রাখুন।',
};

export function createAdmin(deps: AdminDeps, opts: AdminOptions): Hono<AdminEnv> {
  const { billing, repo, onboarding, leads } = deps;
  const app = new Hono<AdminEnv>();
  const now = opts.now ?? (() => new Date());
  const expected = Buffer.from(sha256Hex(`admin:${opts.password}`), 'hex');
  const failures: number[] = [];

  const csrfFor = (token: string) => sha256Hex(`admin-csrf:${token}`).slice(0, 32);

  app.get('/login', (c) => c.html(loginView()));

  app.post('/login', async (c) => {
    const t = now().getTime();
    while (failures.length && failures[0]! < t - LOCKOUT_MS) failures.shift();
    if (failures.length >= LOCKOUT_ATTEMPTS) return c.html(loginView('অনেকবার ভুল পাসওয়ার্ড — ১৫ মিনিট পর চেষ্টা করুন।'), 429);
    const form = await c.req.parseBody();
    const given = Buffer.from(sha256Hex(`admin:${typeof form.password === 'string' ? form.password : ''}`), 'hex');
    if (!timingSafeEqual(given, expected)) {
      failures.push(t);
      return c.html(loginView('পাসওয়ার্ড সঠিক নয়।'), 401);
    }
    failures.length = 0;
    const token = randomBytes(32).toString('base64url');
    repo.createAdminSession(sha256Hex(token), now().toISOString(), new Date(t + SESSION_HOURS * 3600_000).toISOString());
    setCookie(c, COOKIE, token, { httpOnly: true, secure: opts.secureCookies, sameSite: 'Strict', path: '/admin', maxAge: SESSION_HOURS * 3600 });
    return c.redirect('/admin', 303);
  });

  app.use('*', async (c, next) => {
    const token = getCookie(c, COOKIE);
    if (!token || !repo.isAdminSession(sha256Hex(token), now().toISOString())) return c.redirect('/admin/login', 303);
    if (c.req.method === 'POST') {
      const form = await c.req.parseBody();
      const given = typeof form._csrf === 'string' ? form._csrf : '';
      const want = csrfFor(token);
      if (given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
        return c.text('Invalid or missing form token. Reload the page and try again.', 403);
      }
    }
    c.set('session', token);
    c.set('csrf', csrfFor(token));
    await next();
  });

  app.post('/logout', (c) => {
    repo.deleteAdminSession(sha256Hex(c.get('session')));
    deleteCookie(c, COOKIE, { path: '/admin' });
    return c.redirect('/admin/login', 303);
  });

  const MESSAGES: Record<string, string> = {
    approved: 'পেমেন্ট অনুমোদিত — প্ল্যান চালু হয়েছে, বিক্রেতা SMS পেয়েছেন।',
    rejected: 'পেমেন্ট বাতিল — বিক্রেতাকে SMS পাঠানো হয়েছে।',
    granted: 'প্ল্যান সেট করা হয়েছে।',
  };

  const overview = (c: Context<AdminEnv>, extra: { message?: string; error?: string; status?: 200 | 422 } = {}) => {
    const csrf = c.get('csrf');
    const o = billing.overview();
    const pending = billing.pendingPayments();
    const sellers = billing.sellersOverview();
    const invoices = billing.recentInvoices(20);
    const tile = (label: string, value: string) => html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p></div>`;
    return c.html(
      adminPage(
        'অ্যাডমিন',
        csrf,
        html`<h1>ওভারভিউ</h1>
        ${flash('ok', extra.message)} ${flash('error', extra.error)}
        <div class="card"><p class="tile-label">মাসিক রেকারিং রেভিনিউ (MRR)</p><p class="hero">${taka(o.mrrBdt)}</p>
          <p class="muted small">শুধু চালু পেইড প্ল্যান; বাৎসরিক প্ল্যান ১২ দিয়ে ভাগ করা।</p></div>
        <div class="grid" style="margin-top:14px">
          ${tile('পেইড বিক্রেতা', num(o.activePaid))}${tile('গত ৩০ দিনের আয়', taka(o.revenue30dBdt))}
          ${tile('গ্রেস পিরিয়ডে', num(o.grace))}${tile('যাচাই বাকি', num(o.pendingReviews))}
          <a class="tile todo" href="/admin/leads"><p class="tile-label">নতুন পাইলট আবেদন</p><p class="tile-value">${num(leads.counts().new)}</p></a>
        </div>

        <div class="card"><h2>যাচাই বাকি পেমেন্ট</h2>
          ${pending.length === 0
            ? html`<p class="muted">কিছু বাকি নেই।</p>`
            : html`<p class="muted small">bKash/Nagad অ্যাপে TrxID, টাকার অঙ্ক আর প্রেরকের নম্বর মিলিয়ে তারপর অনুমোদন দিন।</p>
              <div class="scroll-x"><table><thead><tr><th>দোকান</th><th>ইনভয়েস</th><th>টাকা</th><th>মাধ্যম</th><th>প্রেরক</th><th>TrxID</th><th>সময়</th><th></th></tr></thead><tbody>
              ${pending.map(
                ({ payment: p, invoice: i, seller: s }) => html`<tr>
                  <td>${s.shopName}<br><span class="muted small">${s.phone ?? ''}</span></td>
                  <td>${i.number}<br><span class="muted small">${planOf(i.plan).name} · ${i.cycle}</span></td>
                  <td><strong>${taka(p.amountBdt)}</strong></td><td>${p.method}</td><td>${p.payerPhone ?? ''}</td>
                  <td><code>${p.reference ?? ''}</code>${p.detail ? html`<br><span class="muted small">${p.detail}</span>` : ''}</td><td>${dateTime(p.createdAt)}</td>
                  <td><form class="inline" method="post" action="/admin/payments/${p.id}">${csrfField(csrf)}<input type="hidden" name="op" value="approve"><button class="primary" type="submit" style="margin:0 0 6px">অনুমোদন</button></form>
                    <form method="post" action="/admin/payments/${p.id}">${csrfField(csrf)}<input type="hidden" name="op" value="reject">
                      <input name="reason" placeholder="কারণ (ঐচ্ছিক)" maxlength="200" style="margin-bottom:4px"><button class="danger" type="submit" style="margin:0">বাতিল</button></form></td>
                </tr>`,
              )}</tbody></table></div>`}
        </div>

        <div class="card"><h2>বিক্রেতা</h2>
          <div class="scroll-x"><table><thead><tr><th>দোকান</th><th>প্ল্যান</th><th>অবস্থা</th><th>মেয়াদ</th><th>MRR</th><th>প্ল্যান সেট করুন</th></tr></thead><tbody>
          ${sellers.map(
            ({ seller: s, state, mrrBdt }) => html`<tr>
              <td>${s.shopName}<br><span class="muted small">${s.phone ?? s.id}</span></td>
              <td>${planOf(state.purchasedPlan).name}</td><td>${STATUS_TEXT[state.status]}</td>
              <td>${state.paidUntil ? dateTime(state.paidUntil.toISOString()) : '—'}</td><td>${mrrBdt > 0 ? taka(mrrBdt) : '—'}</td>
              <td><form method="post" action="/admin/sellers/${s.id}/grant" class="actions" style="flex-wrap:nowrap;align-items:center">${csrfField(csrf)}
                <select name="plan" aria-label="প্ল্যান" style="width:auto">${PLAN_IDS.map((p) => html`<option value="${p}" ${p === s.plan ? raw('selected') : ''}>${planOf(p).name}</option>`)}</select>
                <input name="days" inputmode="numeric" placeholder="দিন" aria-label="কত দিন (খালি = মেয়াদ নেই)" style="width:70px">
                <button type="submit" style="margin:0">সেট</button></form></td>
            </tr>`,
          )}</tbody></table></div>
          <p class="muted small">পাইলটের জন্য: Growth + ১৪ দিন। "দিন" খালি রাখলে মেয়াদ থাকবে না।</p>
        </div>

        <div class="card"><h2>সাম্প্রতিক ইনভয়েস</h2>
          <div class="scroll-x"><table><thead><tr><th>নম্বর</th><th>দোকান</th><th>প্ল্যান</th><th>মোট</th><th>অবস্থা</th><th>তারিখ</th></tr></thead><tbody>
          ${invoices.map(
            ({ invoice: i, seller: s }) => html`<tr><td>${i.number}</td><td>${s.shopName}</td><td>${planOf(i.plan).name} · ${i.cycle}</td>
              <td>${taka(i.totalBdt)}</td><td>${i.status}${i.paymentMethod ? ` · ${i.paymentMethod}` : ''}</td><td>${dateTime(i.createdAt)}</td></tr>`,
          )}</tbody></table></div>
        </div>`,
      ),
      extra.status ?? 200,
    );
  };

  app.get('/', (c) => {
    const msg = c.req.query('msg');
    return overview(c, { message: msg ? MESSAGES[msg] : undefined });
  });

  app.post('/payments/:id', async (c) => {
    const form = await c.req.parseBody();
    try {
      if (form.op === 'approve') {
        await billing.approvePayment(c.req.param('id'));
        return c.redirect('/admin?msg=approved', 303);
      }
      if (form.op === 'reject') {
        await billing.rejectPayment(c.req.param('id'), typeof form.reason === 'string' ? form.reason.trim().slice(0, 200) : '');
        return c.redirect('/admin?msg=rejected', 303);
      }
      return overview(c, { error: 'Unknown action', status: 422 });
    } catch (err) {
      if (err instanceof AppError) return overview(c, { error: err.message, status: 422 });
      throw err;
    }
  });

  app.get('/sellers/new', (c) => {
    const leadId = c.req.query('lead');
    if (!leadId) return c.html(newSellerView(c.get('csrf')));
    try {
      const l = leads.get(leadId);
      return c.html(
        newSellerView(c.get('csrf'), { leadId: l.id, name: l.name, shopName: l.shopName.slice(0, 60), phone: l.phone, plan: suggestedPlan(l) }),
      );
    } catch (err) {
      if (err instanceof AppError) return c.html(newSellerView(c.get('csrf'), {}, 'লিডটি পাওয়া যায়নি।'), 404);
      throw err;
    }
  });

  app.get('/leads', (c) => {
    const q = c.req.query('status') ?? 'new';
    const status = q === 'all' || (LEAD_STATUSES as readonly string[]).includes(q) ? (q as LeadStatus | 'all') : 'new';
    return c.html(
      leadsView(c.get('csrf'), {
        leads: leads.list(status === 'all' ? undefined : status),
        status,
        counts: leads.counts(),
        whatsapp: (l) => leads.whatsappUrl(l),
        now: now(),
        message: c.req.query('msg') === 'updated' ? 'আপডেট হয়েছে।' : undefined,
      }),
    );
  });

  app.post('/leads/:id', async (c) => {
    const form = await c.req.parseBody();
    const back = typeof form.back === 'string' && /^[a-z]+$/.test(form.back) ? form.back : 'new';
    try {
      leads.setStatus(c.req.param('id'), typeof form.status === 'string' ? form.status : '');
    } catch (err) {
      if (err instanceof AppError) return c.text(err.message, err.status === 404 ? 404 : 422);
      throw err;
    }
    return c.redirect(`/admin/leads?status=${back}&msg=updated`, 303);
  });

  app.post('/sellers', async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
    const values: NewSellerValues = {
      name: str('name'),
      shopName: str('shopName'),
      phone: str('phone'),
      plan: str('plan'),
      trialDays: str('trialDays'),
      smsLang: str('smsLang'),
      sendWelcome: form.sendWelcome === '1',
      leadId: str('leadId') || undefined,
    };
    const plan = z.enum(PLAN_IDS).safeParse(values.plan);
    const lang = z.enum(['bn', 'banglish', 'en']).safeParse(values.smsLang);
    const days = values.trialDays === '' ? null : Number(values.trialDays);
    if (!plan.success || !lang.success) return c.html(newSellerView(c.get('csrf'), values, 'প্ল্যান আর ভাষা বেছে নিন।'), 422);
    try {
      const result = await onboarding.onboard({
        name: values.name!,
        shopName: values.shopName!,
        phone: values.phone!,
        plan: plan.data,
        trialDays: plan.data === 'free' ? null : days,
        smsLang: lang.data,
        sendWelcome: values.sendWelcome!,
      });
      if (values.leadId) {
        try {
          leads.markConverted(values.leadId, result.seller.id);
        } catch {
          // The lead may have been deleted meanwhile; the seller exists either way.
        }
      }
      // The page carries a one-time API key: keep it out of caches and browser history.
      c.header('Cache-Control', 'no-store');
      return c.html(createdView(c.get('csrf'), result, now()));
    } catch (err) {
      if (err instanceof AppError) return c.html(newSellerView(c.get('csrf'), values, ONBOARD_ERRORS[err.code] ?? err.message), 422);
      throw err;
    }
  });

  app.post('/sellers/:id/grant', async (c) => {
    const form = await c.req.parseBody();
    const plan = z.enum(PLAN_IDS).safeParse(form.plan);
    const daysRaw = typeof form.days === 'string' ? form.days.trim() : '';
    const days = daysRaw === '' ? null : Number(daysRaw);
    if (!plan.success || (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))) {
      return overview(c, { error: 'প্ল্যান আর দিন (১–৩৬৫০) ঠিকভাবে দিন।', status: 422 });
    }
    try {
      billing.grantPlan(c.req.param('id'), plan.data, plan.data === 'free' ? null : days);
    } catch (err) {
      if (err instanceof AppError) return overview(c, { error: err.message, status: 422 });
      throw err;
    }
    return c.redirect('/admin?msg=granted', 303);
  });

  return app;
}
