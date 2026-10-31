import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanId } from '../src/billing/plans.js';
import { billingPeriod } from '../src/billing/plans.js';
import type { Hono } from 'hono';
import { ADMIN_PASSWORD, createHarness, type HarnessOptions } from './helpers.js';

const DAY = 86_400_000;
let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
});

/** Cookie-keeping client; picks up the CSRF token from the last HTML page. */
function client(app: Hono<any>) {
  const jar = new Map<string, string>();
  let csrf = '';
  const request = async (method: string, path: string, form?: Record<string, string>) => {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await app.request(path, { method, headers, body });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (v) jar.set(k!, v);
      else jar.delete(k!);
    }
    const text = await res.text();
    const token = text.match(/name="_csrf" value="([0-9a-f]{32})"/);
    if (token) csrf = token[1]!;
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, form: Record<string, string> = {}) => request('POST', path, { _csrf: csrf, ...form }),
    rawPost: (path: string, form: Record<string, string>) => request('POST', path, form),
  };
}

async function sellerSession(plan: PlanId = 'free', phone = '01711111111', shopName = 'Rahim Fashion') {
  const { seller, apiKey } = h.service.createSeller({ name: 'Rahim', shopName, plan, phone });
  const b = client(h.app);
  expect((await b.rawPost('/app/login/key', { apiKey })).status).toBe(303);
  await b.get('/app/billing');
  return { b, seller, apiKey, fresh: () => h.service.findSeller(seller.id)! };
}

async function adminSession() {
  const a = client(h.app);
  expect((await a.rawPost('/admin/login', { password: ADMIN_PASSWORD })).status).toBe(303);
  await a.get('/admin');
  return a;
}

/** Creates an invoice through the billing page and returns its path. */
async function buy(b: ReturnType<typeof client>, plan: string, cycle = 'monthly') {
  const res = await b.post('/app/billing', { op: 'create', plan, cycle });
  expect(res.status).toBe(303);
  const path = res.location!.split('?')[0]!;
  await b.get(path);
  return { path, id: path.split('/').at(-1)! };
}

const lastSms = () => h.sms.sent.at(-1)!;

describe('billing page', () => {
  it('shows plans with today’s price and creates an invoice', async () => {
    const { b } = await sellerSession();
    const page = await b.get('/app/billing');
    expect(page.text).toContain('Free</strong> প্ল্যানে আছেন');
    expect(page.text).toContain('৳২,৪৯০');
    expect((await b.get('/app/billing?cycle=annual')).text).toContain('৳২৪,৯০০');

    const { path } = await buy(b, 'growth');
    const invoice = await b.get(path);
    expect(invoice.text).toMatch(/ইনভয়েস SN-\d{4}-00001/);
    expect(invoice.text).toContain('Growth plan · 1 month (30 days)');
    expect(invoice.text).toContain('৳২,৪৯০ পেমেন্ট করুন'); // SSLCommerz
    expect(invoice.text).toContain('01900000001'); // bKash Send Money number
    expect(invoice.text).toContain('01600000001'); // Nagad
  });

  it('keeps one open invoice per seller and isolates sellers', async () => {
    const { b, seller } = await sellerSession();
    const first = await buy(b, 'starter');
    const second = await buy(b, 'growth');
    expect(h.billingRepo.getInvoice(first.id)!.status).toBe('void');
    expect(h.billingRepo.getInvoice(second.id)!.status).toBe('open');
    expect(h.billingRepo.listInvoices(seller.id)).toHaveLength(2);

    const other = await sellerSession('free', '01722222222', 'Other Shop');
    expect((await other.b.get(second.path)).status).toBe(404);
  });

  it('expires unpaid invoices after 24 hours', async () => {
    const { b } = await sellerSession();
    const { path } = await buy(b, 'growth');
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 3600_000);
    const res = await b.post(path, { op: 'online' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('মেয়াদ শেষ');
  });
});

describe('SSLCommerz', () => {
  it('pays online and activates the plan exactly once', async () => {
    const { b, fresh } = await sellerSession();
    const { path, id } = await buy(b, 'growth');

    const go = await b.post(path, { op: 'online' });
    expect(go.status).toBe(303);
    expect(go.location).toMatch(/^https:\/\/sandbox\.sslcommerz\.com\/EasyCheckOut\/testpay_/);
    const session = h.gateway.sessions[0]!;
    expect(session).toMatchObject({
      store_id: 'testbox',
      total_amount: '2490.00',
      currency: 'BDT',
      success_url: 'https://nsc.test/billing/sslcommerz/success',
      ipn_url: 'https://nsc.test/billing/sslcommerz/ipn',
      cus_phone: '01711111111',
    });
    const tranId = session.tran_id!;
    h.gateway.validations[`VAL-${tranId}`] = h.validPayment(tranId, 2490);

    // The payer's browser comes back (cross-site POST, no cookies) …
    const back = await h.app.request('/billing/sslcommerz/success', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tran_id: tranId, val_id: `VAL-${tranId}`, status: 'VALID', amount: '2490.00' }).toString(),
    });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/app/billing/invoices/${id}?msg=paid`);

    const seller = fresh();
    expect(seller).toMatchObject({ plan: 'growth', planCycle: 'monthly' });
    expect(new Date(seller.planPaidUntil!).getTime()).toBe(h.clock.now.getTime() + 30 * DAY);
    expect(h.billingRepo.getInvoice(id)).toMatchObject({ status: 'paid', paymentMethod: 'sslcommerz' });
    expect(lastSms()).toMatchObject({ to: '01711111111' });
    expect(lastSms().text).toContain('Growth plan active until');
    expect((await b.get(`${path}?msg=paid`)).text).toContain('পেমেন্ট সফল');

    // … and the IPN arrives too: no second validation, no second extension.
    const ipn = await h.app.request('/billing/sslcommerz/ipn', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tran_id: tranId, val_id: `VAL-${tranId}`, status: 'VALID' }).toString(),
    });
    expect(await ipn.json()).toEqual({ ok: true, outcome: 'paid' });
    expect(fresh().planPaidUntil).toBe(seller.planPaidUntil);
    expect(h.gateway.validateCalls).toBe(1);

    // Paid orders flow now.
    expect(h.service.planFor(fresh()).monthlyOrders).toBe(2000);
  });

  it('trusts only the validation API, never the callback body', async () => {
    const { b, fresh } = await sellerSession();
    const { path, id } = await buy(b, 'growth');
    await b.post(path, { op: 'online' });
    const tranId = h.gateway.sessions[0]!.tran_id!;
    const post = (fields: Record<string, string>) =>
      h.app.request('/billing/sslcommerz/success', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    // Forged success with a val_id SSLCommerz doesn't know.
    expect((await post({ tran_id: tranId, val_id: 'FORGED', status: 'VALID', amount: '2490.00' })).headers.get('location')).toContain('msg=failed');
    expect(fresh().plan).toBe('free');

    // A real but cheaper payment can't be replayed against this invoice.
    await b.post(path, { op: 'online' });
    const tran2 = h.gateway.sessions[1]!.tran_id!;
    h.gateway.validations['CHEAP'] = h.validPayment(tran2, 10);
    expect((await post({ tran_id: tran2, val_id: 'CHEAP' })).headers.get('location')).toContain('msg=failed');
    expect(fresh().plan).toBe('free');
    expect(h.billingRepo.getInvoice(id)!.status).toBe('open');

    // Unknown transaction id.
    expect((await post({ tran_id: 'pay_nope', val_id: 'X' })).headers.get('location')).toBe('/app/billing');
  });

  it('holds risky payments for review, handles cancel and gateway errors', async () => {
    const { b, fresh } = await sellerSession();
    const { path } = await buy(b, 'growth');
    await b.post(path, { op: 'online' });
    const tranId = h.gateway.sessions[0]!.tran_id!;
    h.gateway.validations['RISKY'] = h.validPayment(tranId, 2490, { risk_level: '1' });
    const res = await h.app.request('/billing/sslcommerz/success', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tran_id=${tranId}&val_id=RISKY`,
    });
    expect(res.headers.get('location')).toContain('msg=review');
    expect(fresh().plan).toBe('free');

    const admin = await adminSession();
    const page = await admin.get('/admin');
    expect(page.text).toContain('SSLCommerz flagged this payment as risky');
    const paymentId = page.text.match(/action="\/admin\/payments\/(pay_[A-Za-z0-9]+)"/)![1]!;
    expect((await admin.post(`/admin/payments/${paymentId}`, { op: 'approve' })).location).toBe('/admin?msg=approved');
    expect(fresh().plan).toBe('growth');

    // Cancel at the gateway.
    const other = await sellerSession('free', '01733333333', 'Shop C');
    const inv = await buy(other.b, 'starter');
    await other.b.post(inv.path, { op: 'online' });
    const t2 = h.gateway.sessions.at(-1)!.tran_id!;
    const cancel = await h.app.request('/billing/sslcommerz/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tran_id=${t2}`,
    });
    expect(cancel.headers.get('location')).toContain('msg=cancelled');
    expect(h.billingRepo.getPayment(t2)!.status).toBe('failed');

    // Gateway refuses to open a session.
    h.gateway.initFails = true;
    const err = await other.b.post(inv.path, { op: 'online' });
    expect(err.status).toBe(422);
    expect(err.text).toContain('পেমেন্ট গেটওয়েতে সমস্যা');
  });
});

describe('manual bKash / Nagad', () => {
  it('takes a TrxID, waits for admin approval and activates the plan', async () => {
    const { b, fresh } = await sellerSession();
    const { path } = await buy(b, 'growth');

    expect((await b.post(path, { op: 'manual', method: 'bkash', payerPhone: '01711111111', reference: 'abc' })).text).toContain('Transaction ID (TrxID) ঠিকভাবে');
    const sent = await b.post(path, { op: 'manual', method: 'bkash', payerPhone: '+8801711111111', reference: '9jk3 l2m4n5' });
    expect(sent.location).toContain('msg=submitted');
    const page = await b.get(path);
    expect(page.text).toContain('যাচাই চলছে');
    expect(page.text).toContain('9JK3L2M4N5');
    expect((await b.post(path, { op: 'manual', method: 'nagad', payerPhone: '01711111111', reference: 'ZZZZ9999' })).text).toContain('আগেই যাচাইয়ের অপেক্ষায়');

    // The same TrxID can't pay someone else's invoice.
    const thief = await sellerSession('free', '01744444444', 'Thief Shop');
    const theirs = await buy(thief.b, 'growth');
    expect((await thief.b.post(theirs.path, { op: 'manual', method: 'bkash', payerPhone: '01744444444', reference: '9JK3L2M4N5' })).text).toContain(
      'আগেই জমা দেওয়া হয়েছে',
    );

    const admin = await adminSession();
    const overview = await admin.get('/admin');
    expect(overview.text).toContain('9JK3L2M4N5');
    expect(overview.text).toContain('Rahim Fashion');
    const paymentId = overview.text.match(/action="\/admin\/payments\/(pay_[A-Za-z0-9]+)"/)![1]!;
    await admin.post(`/admin/payments/${paymentId}`, { op: 'approve' });

    expect(fresh()).toMatchObject({ plan: 'growth', planCycle: 'monthly' });
    expect(lastSms().text).toContain('Payment received');
    expect((await admin.get('/admin')).text).toContain('৳২,৪৯০'); // MRR
    expect((await b.get(path)).text).toContain('পরিশোধিত');
  });

  it('lets the seller retry after a rejection, with the same TrxID', async () => {
    const { b, fresh } = await sellerSession();
    const { path } = await buy(b, 'starter');
    await b.post(path, { op: 'manual', method: 'nagad', payerPhone: '01711111111', reference: 'NG123456' });
    const admin = await adminSession();
    const paymentId = (await admin.get('/admin')).text.match(/action="\/admin\/payments\/(pay_[A-Za-z0-9]+)"/)![1]!;
    expect((await admin.post(`/admin/payments/${paymentId}`, { op: 'reject', reason: 'amount mismatch' })).location).toBe('/admin?msg=rejected');
    expect(lastSms().text).toContain('could not verify');
    expect(fresh().plan).toBe('free');

    expect((await b.post(path, { op: 'manual', method: 'nagad', payerPhone: '01711111111', reference: 'NG123456' })).location).toContain('msg=submitted');
  });

  it('hides payment methods that are not configured', async () => {
    h = createHarness({ sslcommerz: false, manual: false } satisfies HarnessOptions);
    const { b } = await sellerSession();
    const { path } = await buy(b, 'growth');
    expect((await b.get(path)).text).toContain('পেমেন্ট নেওয়া এখনো চালু হয়নি');
    expect((await b.post(path, { op: 'online' })).text).toContain('অনলাইন পেমেন্ট এখনো চালু হয়নি');
  });
});

describe('plan changes, credit and overage', () => {
  it('credits unused days on upgrade', async () => {
    const { b, seller, fresh } = await sellerSession();
    h.billing.grantPlan(seller.id, 'starter', null);
    h.store.updateSeller(seller.id, {
      planCycle: 'monthly',
      planPaidUntil: new Date(h.clock.now.getTime() + 20 * DAY).toISOString(),
      planDailyRate: 33,
    });
    const quote = h.billing.quote(fresh(), 'growth', 'monthly');
    expect(quote).toMatchObject({ subtotalBdt: 2490, prorationCreditBdt: 660, creditAppliedBdt: 660, totalBdt: 1830, creditAfterBdt: 0 });
    const page = await b.get('/app/billing');
    expect(page.text).toContain('আজ দেবেন <strong>৳১,৮৩০</strong>');
  });

  it('turns a downgrade into account credit and activates without paying', async () => {
    const { b, seller, fresh } = await sellerSession();
    h.store.updateSeller(seller.id, {
      plan: 'growth',
      planCycle: 'annual',
      planPaidUntil: new Date(h.clock.now.getTime() + 300 * DAY).toISOString(),
      planDailyRate: 24_900 / 365,
    });
    const { path } = await buy(b, 'starter');
    expect((await b.get(path)).text).toContain('ক্রেডিট দিয়ে চালু করুন');
    expect((await b.post(path, { op: 'credit' })).location).toContain('msg=paid');
    const s = fresh();
    expect(s).toMatchObject({ plan: 'starter', planCycle: 'monthly', creditBdt: Math.floor(300 * (24_900 / 365)) - 990 });

    // The credit pays the next renewal too.
    const renewal = h.billing.quote(s, 'starter', 'monthly');
    expect(renewal).toMatchObject({ totalBdt: 0, balanceCreditBdt: s.creditBdt });
  });

  it('stacks a same-plan renewal onto the current period', async () => {
    const { b, seller, fresh } = await sellerSession();
    const end = new Date(h.clock.now.getTime() + 10 * DAY).toISOString();
    h.store.updateSeller(seller.id, { plan: 'growth', planCycle: 'monthly', planPaidUntil: end, planDailyRate: 83 });
    const { path } = await buy(b, 'growth');
    await b.post(path, { op: 'manual', method: 'bkash', payerPhone: '01711111111', reference: 'RENEW12345' });
    await h.billing.approvePayment(h.billingRepo.listPaymentsByStatus('pending_review')[0]!.id);
    expect(new Date(fresh().planPaidUntil!).getTime()).toBe(new Date(end).getTime() + 30 * DAY);
  });

  it('records overage as it happens and bills it once', async () => {
    const { b, seller, apiKey, fresh } = await sellerSession();
    h.billing.grantPlan(seller.id, 'starter', null);
    const thisMonth = billingPeriod(h.clock.now);
    h.store.incrementUsage(seller.id, thisMonth, { orders: 500 });
    const res = await h.app.request('/v1/orders', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ customerName: 'K', phone: '01712345678', address: 'House 1, Road 2, Mirpur, Dhaka', codAmount: 500, items: [] }),
    });
    expect(res.status).toBe(201);
    expect(h.store.getUsage(seller.id, thisMonth).overageOrders).toBe(1);

    // Last month's overage shows up on the next invoice; the current month is not billed yet.
    h.store.incrementUsage(seller.id, '2000-01', { orders: 600, overageOrders: 100 });
    const { path, id } = await buy(b, 'starter');
    const inv = h.billingRepo.getInvoice(id)!;
    expect(inv.lines.map((l) => [l.kind, l.amountBdt])).toEqual([['plan', 990], ['overage', 150]]);
    expect(inv.totalBdt).toBe(1140);
    expect((await b.get(path)).text).toContain('Extra orders in 2000-01: 100 × Tk 1.5');

    await b.post(path, { op: 'manual', method: 'bkash', payerPhone: '01711111111', reference: 'OVER123456' });
    await h.billing.approvePayment(h.billingRepo.listPaymentsByStatus('pending_review')[0]!.id);
    expect(h.billing.quote(fresh(), 'starter', 'monthly').lines.map((l) => l.kind)).toEqual(['plan']);
  });
});

describe('expiry and reminders', () => {
  it('keeps working through grace, then falls back to Free', async () => {
    const { b, seller, apiKey, fresh } = await sellerSession();
    const order = () =>
      h.app.request('/v1/orders', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ customerName: 'K', phone: '01712345678', address: 'House 1, Road 2, Mirpur, Dhaka', codAmount: 500, items: [] }),
      });
    h.store.updateSeller(seller.id, {
      plan: 'growth',
      planCycle: 'monthly',
      planPaidUntil: new Date(h.clock.now.getTime() - 2 * DAY).toISOString(),
      planDailyRate: 83,
    });
    expect((await order()).status).toBe(201);
    expect((await b.get('/app')).text).toContain('রিনিউ না করলে অর্ডার অটোমেশন বন্ধ হয়ে যাবে');

    h.clock.now = new Date(h.clock.now.getTime() + 2 * DAY);
    expect((await order()).status).toBe(402);
    expect((await b.get('/app')).text).toContain('এখন Free প্ল্যান চলছে');
    expect(fresh().plan).toBe('growth'); // what they bought is kept for renewal
  });

  it('sends each renewal reminder once', async () => {
    const { seller } = await sellerSession();
    h.store.updateSeller(seller.id, {
      plan: 'growth',
      planCycle: 'monthly',
      planPaidUntil: new Date(h.clock.now.getTime() + 4.5 * DAY).toISOString(),
      planDailyRate: 83,
    });
    const step = async (days: number) => {
      h.clock.now = new Date(h.clock.now.getTime() + days * DAY);
      return h.billing.runReminders();
    };
    expect(await step(0)).toBe(1);
    expect(lastSms().text).toContain('Your Growth plan ends on');
    expect(await step(0)).toBe(0);
    expect(await step(3.6)).toBe(1);
    expect(lastSms().text).toContain('ends tomorrow');
    expect(await step(1)).toBe(1);
    expect(lastSms().text).toContain('has ended');
    expect(await step(3)).toBe(1);
    expect(lastSms().text).toContain('now on the Free plan');
    expect(await step(2)).toBe(0);
  });
});

describe('admin console', () => {
  it('needs the password, rate-limits guesses and requires CSRF', async () => {
    const a = client(h.app);
    expect((await a.get('/admin')).location).toBe('/admin/login');
    for (let i = 0; i < 5; i++) expect((await a.rawPost('/admin/login', { password: 'wrong' })).status).toBe(401);
    expect((await a.rawPost('/admin/login', { password: ADMIN_PASSWORD })).status).toBe(429);

    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    const admin = await adminSession();
    const { seller } = await sellerSession();
    expect((await admin.rawPost(`/admin/sellers/${seller.id}/grant`, { plan: 'growth', days: '14' })).status).toBe(403);
    expect((await admin.post(`/admin/sellers/${seller.id}/grant`, { plan: 'growth', days: '14' })).location).toBe('/admin?msg=granted');
    const s = h.service.findSeller(seller.id)!;
    expect(s.plan).toBe('growth');
    expect(new Date(s.planPaidUntil!).getTime()).toBe(h.clock.now.getTime() + 14 * DAY);
    expect(h.billing.state(s).status).toBe('active');
  });

  it('is off without ADMIN_PASSWORD', async () => {
    h = createHarness({ admin: false });
    expect((await h.app.request('/admin/login')).status).toBe(404);
  });
});
