import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, client, createHarness } from './helpers.js';

const DAY = 86_400_000;
let h: ReturnType<typeof createHarness>;
beforeEach(() => {
  h = createHarness();
  cookie = '';
});

async function adminSession() {
  const a = client(h.app);
  expect((await a.rawPost('/admin/login', { password: ADMIN_PASSWORD })).status).toBe(303);
  await a.get('/admin/sellers/new');
  return a;
}

const FORM = {
  name: 'Rahim Uddin',
  shopName: 'Rahim Fashion',
  phone: '+880 1711-111111',
  plan: 'growth',
  trialDays: '14',
  smsLang: 'bn',
  sendWelcome: '1',
};

describe('admin: add seller', () => {
  it('is admin-only and needs the form token', async () => {
    const anon = client(h.app);
    expect((await anon.get('/admin/sellers/new')).location).toBe('/admin/login');
    const a = await adminSession();
    expect((await a.rawPost('/admin/sellers', FORM)).status).toBe(403);
    expect(h.service.findSellerByPhone('01711111111')).toBeNull();
  });

  it('signs up a pilot seller, texts the login link and shows the API key once', async () => {
    const a = await adminSession();
    const form = await a.get('/admin/sellers/new');
    expect(form.text).toContain('নতুন বিক্রেতা');
    expect(form.text).toContain('value="14"');

    const res = await a.post('/admin/sellers', FORM);
    expect(res.status).toBe(200);
    const seller = h.service.findSellerByPhone('01711111111')!;
    expect(seller).toMatchObject({ name: 'Rahim Uddin', shopName: 'Rahim Fashion', phone: '01711111111', plan: 'growth', smsLang: 'bn' });
    expect(new Date(seller.planPaidUntil!).getTime()).toBe(h.clock.now.getTime() + 14 * DAY);
    expect(h.billing.state(seller).status).toBe('active');

    // Welcome SMS with the login link, in the chosen language.
    const sms = h.sms.sent.at(-1)!;
    expect(sms.to).toBe('01711111111');
    expect(sms.text).toBe('Rahim Fashion-এর জন্য Shipnod চালু হয়েছে! এই নম্বর দিয়ে লগইন করুন: https://nsc.test/app/login');
    expect(res.text).toContain('লগইন লিংক 01711111111 নম্বরে SMS করা হয়েছে');

    // The one-time API key works, and the page is never cached.
    const apiKey = res.text.match(/value="(nsk_[A-Za-z0-9]+)"/)![1]!;
    expect(h.service.authenticate(apiKey)!.id).toBe(seller.id);
    const raw = await h.app.request('/admin/sellers', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: (await loginCookie()) },
      body: new URLSearchParams({ ...FORM, phone: '01722222222', _csrf: await csrfFor() }).toString(),
    });
    expect(raw.headers.get('cache-control')).toBe('no-store');

    // WhatsApp hand-off carries the welcome text, never the key.
    const wa = res.text.match(/href="(https:\/\/wa\.me\/[^"]+)"/)![1]!.replace(/&amp;/g, '&');
    expect(wa.startsWith('https://wa.me/8801711111111?text=')).toBe(true);
    expect(decodeURIComponent(wa.split('text=')[1]!)).toContain('/app/login');
    expect(wa).not.toContain('nsk_');

    // The new seller can log in with that phone straight away.
    const seller2 = client(h.app);
    await seller2.rawPost('/app/login', { phone: '01711111111' });
    expect(h.sms.sent.at(-1)!.text).toMatch(/login code is \d{6}/);
  });

  it('refuses a phone that is already registered, keeping what was typed', async () => {
    const a = await adminSession();
    await a.post('/admin/sellers', FORM);
    await a.get('/admin/sellers/new');
    const again = await a.post('/admin/sellers', { ...FORM, shopName: 'Another Shop', phone: '01711111111' });
    expect(again.status).toBe(422);
    expect(again.text).toContain('এই নম্বরে আগেই একজন বিক্রেতা আছে');
    expect(again.text).toContain('value="Another Shop"');
    expect(h.store.listSellers()).toHaveLength(1);
  });

  it('validates the form', async () => {
    const a = await adminSession();
    const cases: Array<[Record<string, string>, string]> = [
      [{ phone: '12345' }, 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন'],
      [{ shopName: '' }, 'দোকানের নাম দিন'],
      [{ name: '' }, 'মালিকের নাম দিন'],
      [{ trialDays: '0' }, 'পাইলটের দিন ১ থেকে ৩৬৫'],
      [{ trialDays: 'abc' }, 'পাইলটের দিন ১ থেকে ৩৬৫'],
      [{ plan: 'platinum' }, 'প্ল্যান আর ভাষা বেছে নিন'],
    ];
    for (const [override, message] of cases) {
      const res = await a.post('/admin/sellers', { ...FORM, ...override });
      expect(res.status, JSON.stringify(override)).toBe(422);
      expect(res.text).toContain(message);
    }
    expect(h.store.listSellers()).toHaveLength(0);
    expect(h.sms.sent).toHaveLength(0);
  });

  it('supports comped and free accounts, and skipping the SMS', async () => {
    const a = await adminSession();
    const comped = await a.post('/admin/sellers', { ...FORM, trialDays: '', sendWelcome: '' });
    expect(comped.text).toContain('Growth · মেয়াদ নেই');
    expect(h.service.findSellerByPhone('01711111111')!.planPaidUntil).toBeNull();
    expect(h.sms.sent).toHaveLength(0);

    await a.get('/admin/sellers/new');
    await a.post('/admin/sellers', { ...FORM, phone: '01822222222', plan: 'free', trialDays: '14', smsLang: 'en' });
    const free = h.service.findSellerByPhone('01822222222')!;
    expect(free).toMatchObject({ plan: 'free', planPaidUntil: null, smsLang: 'en' });
    expect(h.sms.sent.at(-1)!.text).toBe('Shipnod is ready for Rahim Fashion! Log in with this number: https://nsc.test/app/login');
  });

  it('still creates the seller when the welcome SMS fails', async () => {
    const send = h.sms.send.bind(h.sms);
    h.sms.send = async () => ({ ok: false, error: 'insufficient balance' });
    const a = await adminSession();
    const res = await a.post('/admin/sellers', FORM);
    expect(res.status).toBe(200);
    expect(res.text).toContain('SMS যায়নি: insufficient balance');
    expect(res.text).toContain('WhatsApp-এ পাঠান');
    expect(h.service.findSellerByPhone('01711111111')).not.toBeNull();
    h.sms.send = send;
  });
});

// Raw-request helpers for header checks.
let cookie = '';
async function loginCookie() {
  if (cookie) return cookie;
  const res = await h.app.request('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${ADMIN_PASSWORD}`,
  });
  cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  return cookie;
}
async function csrfFor() {
  const page = await (await h.app.request('/admin/sellers/new', { headers: { cookie: await loginCookie() } })).text();
  return page.match(/name="_csrf" value="([0-9a-f]{32})"/)![1]!;
}
