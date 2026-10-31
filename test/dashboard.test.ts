import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanId } from '../src/billing/plans.js';
import { createHarness } from './helpers.js';

let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
});

/** Minimal cookie-keeping browser over app.request. */
function browser() {
  let cookie = '';
  let csrf = '';
  const request = async (method: string, path: string, form?: Record<string, string>) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await h.app.request(path, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    const m = setCookie?.match(/shipnod_session=([^;]*)/);
    if (m) cookie = m[1] ? `shipnod_session=${m[1]}` : '';
    const text = await res.text();
    const token = text.match(/name="_csrf" value="([0-9a-f]{32})"/);
    if (token) csrf = token[1]!;
    return { status: res.status, location: res.headers.get('location'), text, setCookie };
  };
  return {
    get: (path: string) => request('GET', path),
    /** POST a form; adds the CSRF token from the last page unless `_csrf` is given. */
    post: (path: string, form: Record<string, string> = {}) => request('POST', path, { _csrf: csrf, ...form }),
    rawPost: (path: string, form: Record<string, string>) => request('POST', path, form),
    get cookie() {
      return cookie;
    },
  };
}

const lastCode = () => h.sms.sent.at(-1)!.text.match(/\b(\d{6})\b/)![1]!;

function seller(plan: PlanId = 'growth', phone = '01711111111', shopName = 'Rahim Fashion') {
  return h.service.createSeller({ name: 'Owner', shopName, plan, phone });
}

async function loggedIn(plan: PlanId = 'growth', phone = '01711111111', shopName = 'Rahim Fashion') {
  const s = seller(plan, phone, shopName);
  const b = browser();
  await b.rawPost('/app/login', { phone });
  const res = await b.rawPost('/app/login/verify', { phone, code: lastCode() });
  expect(res.status).toBe(303);
  await b.get('/app'); // load a page to pick up the CSRF token
  return { b, ...s };
}

const ORDER_FORM = {
  customerName: 'Karim',
  phone: '01712345678',
  address: 'House 12, Road 5, Dhanmondi, Dhaka',
  district: 'Dhaka',
  codAmount: '1450',
  item0name: 'Panjabi',
  item0qty: '1',
  item0price: '1450',
};

describe('dashboard login', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const b = browser();
    const res = await b.get('/app');
    expect(res.status).toBe(303);
    expect(res.location).toBe('/app/login');
    expect((await b.get('/app/login')).text).toContain('কোড পাঠান');
  });

  it('logs in with a phone number and SMS code', async () => {
    seller();
    const b = browser();
    const ask = await b.rawPost('/app/login', { phone: '+880 1711-111111' });
    expect(ask.status).toBe(200);
    expect(ask.text).toContain('01711111111');
    expect(h.sms.sent.at(-1)!.to).toBe('01711111111');

    const wrong = await b.rawPost('/app/login/verify', { phone: '01711111111', code: '000000' === lastCode() ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('কোডটি সঠিক নয়');

    const ok = await b.rawPost('/app/login/verify', { phone: '01711111111', code: lastCode() });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe('/app');
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect(ok.setCookie).toMatch(/SameSite=Lax/i);
    expect(ok.setCookie).toMatch(/Path=\/app/);

    const home = await b.get('/app');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Rahim Fashion');
    expect(home.text).toContain('আনুমানিক সাশ্রয়');

    // A used code cannot be replayed.
    expect((await browser().rawPost('/app/login/verify', { phone: '01711111111', code: lastCode() })).status).toBe(401);
  });

  it('does not reveal whether a number is registered', async () => {
    const res = await browser().rawPost('/app/login', { phone: '01899999999' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('কোড দিন');
    expect(h.sms.sent).toHaveLength(0);
    expect((await browser().rawPost('/app/login', { phone: '12345' })).status).toBe(400);
  });

  it('limits resends, wrong guesses and code lifetime', async () => {
    seller();
    const b = browser();
    await b.rawPost('/app/login', { phone: '01711111111' });
    const again = await b.rawPost('/app/login', { phone: '01711111111' });
    expect(again.text).toContain('অপেক্ষা করুন');
    expect(h.sms.sent).toHaveLength(1);

    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await b.rawPost('/app/login/verify', { phone: '01711111111', code: wrong });
    expect((await b.rawPost('/app/login/verify', { phone: '01711111111', code: wrong })).text).toContain('অনেকবার ভুল');
    expect((await b.rawPost('/app/login/verify', { phone: '01711111111', code })).status).toBe(401);

    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    await b.rawPost('/app/login', { phone: '01711111111' });
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000);
    expect((await b.rawPost('/app/login/verify', { phone: '01711111111', code: lastCode() })).text).toContain('মেয়াদ শেষ');
  });

  it('accepts an API key and logs out', async () => {
    const { apiKey } = h.service.createSeller({ name: 'O', shopName: 'Key Shop', plan: 'starter' });
    const b = browser();
    expect((await b.rawPost('/app/login/key', { apiKey: 'nsk_wrong' })).status).toBe(401);
    expect((await b.rawPost('/app/login/key', { apiKey })).status).toBe(303);
    expect((await b.get('/app')).text).toContain('Key Shop');

    const out = await b.post('/app/logout');
    expect(out.location).toBe('/app/login');
    expect(b.cookie).toBe('');
    expect((await b.get('/app')).status).toBe(303);
  });
});

describe('dashboard orders', () => {
  it('rejects form posts without the CSRF token', async () => {
    const { b } = await loggedIn();
    expect((await b.rawPost('/app/orders/new', ORDER_FORM)).status).toBe(403);
    expect((await b.post('/app/orders/new', { ...ORDER_FORM, _csrf: 'f'.repeat(32) })).status).toBe(403);
  });

  it('runs an order from entry to delivery through the forms', async () => {
    const { b } = await loggedIn();

    const created = await b.post('/app/orders/new', ORDER_FORM);
    expect(created.status).toBe(303);
    const path = created.location!.split('?')[0]!;
    const detail = await b.get(created.location!);
    expect(detail.text).toContain('অর্ডার যোগ হয়েছে');
    expect(detail.text).toContain('কনফার্মেশন SMS পাঠানো হয়েছে');
    expect(detail.text).toContain('মাঝারি ঝুঁকি');
    expect(detail.text).toContain('এই নম্বরে এখনো কোনো ডেলিভারির রেকর্ড নেই');
    expect(h.sms.sent.at(-1)!.to).toBe('01712345678');

    expect((await b.post(path, { op: 'confirm' })).status).toBe(303);
    expect((await b.get(path)).text).toContain('কনফার্মড — বুকিং বাকি');

    // Booking before a courier is connected explains what to do.
    const noCourier = await b.post(path, { op: 'book', courier: 'steadfast' });
    expect(noCourier.status).toBe(422);
    expect(noCourier.text).toContain('আগে সেটিংসে এই কুরিয়ার যুক্ত করুন');

    await b.get('/app/settings');
    expect((await b.post('/app/settings', { op: 'courier', courier: 'steadfast', apiKey: 'k', secretKey: 's' })).status).toBe(303);
    await b.get(path);
    expect((await b.post(path, { op: 'book', courier: 'steadfast', weightKg: '1' })).status).toBe(303);
    const booked = await b.get(`${path}?msg=book`);
    expect(booked.text).toContain('কুরিয়ারে বুক করা হয়েছে');
    expect(booked.text).toContain('steadfast · 987');

    expect((await b.post(path, { op: 'delivered' })).status).toBe(303);
    const done = await b.get(path);
    expect(done.text).toContain('ডেলিভারড');
    expect(done.text).toContain('এই অর্ডারে আর কিছু করার নেই');

    const home = await b.get('/app');
    expect(home.text).toContain('০%'); // RTO rate: 0 returned of 1 delivered
  });

  it('escapes customer-supplied text', async () => {
    const { b } = await loggedIn();
    const res = await b.post('/app/orders/new', { ...ORDER_FORM, customerName: '<script>alert(1)</script>', note: '"><img src=x onerror=alert(1)>' });
    const page = await b.get(res.location!);
    expect(page.text).not.toContain('<script>alert(1)</script>');
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('re-shows the form with an explanation on bad input', async () => {
    const { b } = await loggedIn();
    const res = await b.post('/app/orders/new', { ...ORDER_FORM, codAmount: 'abc' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('ডেলিভারিতে নেওয়ার টাকা সঠিকভাবে লিখুন');
    expect(res.text).toContain('value="Karim"'); // keeps what the seller typed
  });

  it('filters orders by tab, risk level and search', async () => {
    const { b } = await loggedIn();
    await b.post('/app/orders/new', ORDER_FORM); // medium -> awaiting confirmation
    await b.post('/app/orders/new', { ...ORDER_FORM, customerName: 'Prepaid Rina', phone: '01811223344', codAmount: '0' }); // low -> confirmed
    await b.post('/app/orders/new', { ...ORDER_FORM, customerName: 'Bad Number', phone: '01234567890' }); // invalid -> on hold

    const action = await b.get('/app/orders?tab=action');
    expect(action.text).toContain('Prepaid Rina');
    expect(action.text).toContain('Bad Number');
    expect(action.text).not.toContain('>Karim<');
    expect(action.text).toContain('কাজ বাকি (২)');

    const waiting = await b.get('/app/orders?tab=waiting');
    expect(waiting.text).toContain('>Karim<');

    const low = await b.get('/app/orders?tab=all&level=low');
    expect(low.text).toContain('Prepaid Rina');
    expect(low.text).not.toContain('>Karim<');

    const search = await b.get(`/app/orders?q=${encodeURIComponent('০১৮১১২২৩৩৪৪')}`);
    expect(search.text).toContain('Prepaid Rina');
    expect(search.text).not.toContain('>Karim<');
  });

  it('keeps sellers apart', async () => {
    const a = await loggedIn('growth', '01711111111', 'Shop A');
    const created = await a.b.post('/app/orders/new', ORDER_FORM);
    const path = created.location!.split('?')[0]!;

    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    const other = await loggedIn('growth', '01722222222', 'Shop B');
    expect((await other.b.get(path)).status).toBe(404);
    expect((await other.b.post(path, { op: 'cancel' })).status).toBe(404);
    expect((await other.b.get('/app/orders')).text).not.toContain('>Karim<');
  });

  it('checks a customer before taking the order', async () => {
    const { b } = await loggedIn();
    const res = await b.post('/app/check', { phone: '+8801712345678' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('01712345678');
    expect(res.text).toContain('পাঠানোর আগে কনফার্ম করিয়ে নিন');
    expect((await b.post('/app/check', { phone: '12345' })).text).toContain('সঠিক বাংলাদেশি মোবাইল নম্বর নয়');
  });
});

describe('dashboard settings', () => {
  it('saves shop settings and previews SMS cost', async () => {
    const { b, seller: s } = await loggedIn();
    const page = await b.get('/app/settings');
    expect(page.text).toContain('২ পার্ট SMS'); // Bangla confirmation
    expect(page.text).toContain('১ পার্ট SMS'); // Banglish / English
    expect(page.text).toContain(`/webhooks/woocommerce/${s.id}`);

    const bad = await b.post('/app/settings', {
      op: 'profile', shopName: 'Rahim', smsLang: 'banglish', advanceFeeBdt: '120', costPerFailedOrderBdt: '180', bkashNumber: '123',
    });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain('সঠিক বাংলাদেশি মোবাইল নম্বর দিন');

    const ok = await b.post('/app/settings', {
      op: 'profile', shopName: 'Rahim Fashion BD', smsLang: 'banglish', advanceFeeBdt: '120', costPerFailedOrderBdt: '180', bkashNumber: '+8801812345678',
    });
    expect(ok.location).toBe('/app/settings?msg=profile');
    const updated = h.service.findSeller(s.id)!;
    expect(updated).toMatchObject({ shopName: 'Rahim Fashion BD', smsLang: 'banglish', advanceFeeBdt: 120, costPerFailedOrderBdt: 180, bkashNumber: '01812345678' });
  });

  it('gates custom risk rules by plan and validates thresholds', async () => {
    const starter = await loggedIn('starter', '01733333333');
    const denied = await starter.b.post('/app/settings', { op: 'risk', mediumAt: '40', highAt: '70', criticalAt: '90' });
    expect(denied.status).toBe(422);
    expect(denied.text).toContain('আপনার প্ল্যানে এটি নেই');

    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    const growth = await loggedIn('growth', '01744444444');
    expect((await growth.b.post('/app/settings', { op: 'risk', mediumAt: '70', highAt: '60', criticalAt: '90' })).status).toBe(422);
    await growth.b.post('/app/settings', { op: 'risk', mediumAt: '40', highAt: '70', criticalAt: '90' });
    expect(h.service.findSeller(growth.seller.id)!.riskPolicy).toEqual({ mediumAt: 40, highAt: 70, criticalAt: 90, advancePaymentEnabled: false });
    await growth.b.post('/app/settings', { op: 'risk', reset: '1' });
    expect(h.service.findSeller(growth.seller.id)!.riskPolicy).toBeNull();
  });

  it('blocks and unblocks numbers, showing them masked', async () => {
    const { b } = await loggedIn();
    await b.get('/app/settings');
    await b.post('/app/settings', { op: 'block', phone: '01399998888', reason: 'fake orders' });
    const page = await b.get('/app/settings');
    expect(page.text).toContain('013****8888');
    expect(page.text).not.toContain('01399998888');

    const created = await b.post('/app/orders/new', { ...ORDER_FORM, phone: '01399998888' });
    expect((await b.get(created.location!)).text).toContain('হোল্ডে');

    const hash = page.text.match(/name="hash" value="([0-9a-f]{64})"/)![1]!;
    await b.post('/app/settings', { op: 'unblock', hash });
    expect((await b.get('/app/settings')).text).toContain('কোনো নম্বর ব্লক করা নেই');
  });

  it('enforces the courier limit of the plan', async () => {
    const { b } = await loggedIn('starter', '01755555555');
    await b.get('/app/settings');
    await b.post('/app/settings', { op: 'courier', courier: 'steadfast', apiKey: 'k', secretKey: 's' });
    const second = await b.post('/app/settings', { op: 'courier', courier: 'redx', accessToken: 't', pickupStoreId: '1' });
    expect(second.status).toBe(422);
    expect(second.text).toContain('আপনার প্ল্যানে এটি নেই');
  });
});
