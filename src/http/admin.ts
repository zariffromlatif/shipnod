import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html, raw } from 'hono/html';
import { z } from 'zod';
import { PLAN_IDS, planOf } from '../billing/plans.js';
import type { BillingRepo } from '../db/billing-repo.js';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import type { BillingService } from '../services/billing.js';
import { csrfField, dateTime, flash, num, shell, taka, type Html } from './dashboard/ui.js';

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
        ${csrf ? html`<form class="inline" method="post" action="/admin/logout">${csrfField(csrf)}<button type="submit">লগআউট</button></form>` : ''}
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

export function createAdmin(billing: BillingService, repo: BillingRepo, opts: AdminOptions): Hono<AdminEnv> {
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
