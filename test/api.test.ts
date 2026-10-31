import { beforeEach, describe, expect, it } from 'vitest';
import { ConsoleSmsProvider } from '../src/confirmation/sms.js';
import { Store } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import { SecretBox, signBase64Hmac } from '../src/lib/crypto.js';
import { NishchitService } from '../src/services/nishchit.js';
import type { PlanId } from '../src/billing/plans.js';

const ADDRESS = 'House 12, Road 5, Dhanmondi, Dhaka';

function setup() {
  const store = new Store(':memory:');
  const sms = new ConsoleSmsProvider(true);
  let deliveryStatus = 'pending';
  const courierCalls: string[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    courierCalls.push(url);
    if (url.endsWith('/create_order')) {
      return Response.json({ status: 200, consignment: { consignment_id: 987, tracking_code: 'SF987', status: 'in_review' } });
    }
    if (url.includes('/status_by_cid/')) return Response.json({ status: 200, delivery_status: deliveryStatus });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const clock = { now: new Date() };
  clock.now.setUTCHours(8, 0, 0, 0); // 14:00 in Dhaka: keeps LATE_NIGHT out of the scores

  const service = new NishchitService({
    store,
    sms,
    secretBox: new SecretBox('cd'.repeat(32)),
    networkHashSecret: 'test-network-secret-at-least-32-characters',
    publicBaseUrl: 'https://nsc.test',
    confirmTtlHours: 48,
    courierSandbox: true,
    fetch: fakeFetch,
    now: () => clock.now,
  });
  const app = createApp(service);

  const sellerClient = (plan: PlanId, shopName = 'Rahim Fashion') => {
    const { seller, apiKey } = service.createSeller({ name: 'Owner', shopName, plan });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    return { seller, apiKey, call };
  };

  const order = (phone: string, extra: Record<string, unknown> = {}) => ({
    customerName: 'Karim',
    phone,
    address: ADDRESS,
    codAmount: 1450,
    items: [{ name: 'Panjabi', quantity: 1, unitPrice: 1450 }],
    ...extra,
  });

  const lastCode = () => {
    const text = sms.sent.at(-1)!.text;
    return text.match(/\/c\/([0-9A-Za-z]{8})/)![1]!;
  };

  const customer = (code: string, decision: 'confirm' | 'cancel') =>
    app.request(`/c/${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `decision=${decision}`,
    });

  return {
    store,
    sms,
    service,
    app,
    clock,
    courierCalls,
    sellerClient,
    order,
    lastCode,
    customer,
    setDelivery: (s: string) => (deliveryStatus = s),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe('seller API', () => {
  it('rejects requests without a valid key', async () => {
    expect((await t.app.request('/v1/orders')).status).toBe(401);
    expect((await t.app.request('/v1/orders', { headers: { authorization: 'Bearer nsk_wrong' } })).status).toBe(401);
  });

  it('runs the full loop: confirm by SMS, book, sync delivery, trust the customer next time', async () => {
    const { call } = t.sellerClient('growth');
    expect((await call('PUT', '/v1/couriers/steadfast', { credentials: { apiKey: 'k', secretKey: 's' } })).json.connected).toEqual([
      'steadfast',
    ]);

    // 1. Unknown customer -> confirmation SMS.
    const created = await call('POST', '/v1/orders', t.order('+880 1712-345678'));
    expect(created.status).toBe(201);
    const first = created.json.order;
    expect(first).toMatchObject({ status: 'awaiting_confirmation', phone: '01712345678', phoneValid: true });
    expect(first.risk).toMatchObject({ level: 'medium', action: 'confirm' });
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.to).toBe('01712345678');
    expect(t.sms.sent[0]!.text).toContain('৳১৪৫০');

    // 2. Customer opens the link and confirms.
    const code = t.lastCode();
    const page = await t.app.request(`/c/${code}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('আপনি কি এই অর্ডারটি করেছেন?');
    const confirmed = await t.customer(code, 'confirm');
    expect(await confirmed.text()).toContain('আপনার অর্ডার নিশ্চিত হয়েছে');
    expect((await call('GET', `/v1/orders/${first.id}`)).json.order.status).toBe('confirmed');

    // 3. Book with Steadfast.
    const booked = await call('POST', `/v1/orders/${first.id}/book`, { courier: 'steadfast' });
    expect(booked.json.order).toMatchObject({ status: 'booked', courier: 'steadfast', consignmentId: '987', trackingCode: 'SF987' });

    // 4. Courier sync: in transit, then delivered.
    t.setDelivery('pending');
    expect(await t.service.syncShippedOrders()).toEqual({ checked: 1, updated: 1, errors: 0 });
    t.setDelivery('delivered');
    expect(await t.service.syncShippedOrders()).toEqual({ checked: 1, updated: 1, errors: 0 });
    const done = await call('GET', `/v1/orders/${first.id}`);
    expect(done.json.order.status).toBe('delivered');
    expect(done.json.events.map((e: any) => e.to)).toEqual(['new', 'awaiting_confirmation', 'confirmed', 'booked', 'in_transit', 'delivered']);

    // 5. Same customer (typed in Bangla digits) is now trusted and ships without an SMS.
    const second = await call('POST', '/v1/orders', t.order('০১৭১২৩৪৫৬৭৮'));
    expect(second.json.order.risk).toMatchObject({ level: 'low', action: 'auto_ship', deliverySuccessRate: 1, ordersSeen: 1 });
    expect(second.json.order.status).toBe('confirmed');
    expect(t.sms.sent).toHaveLength(1);
  });

  it('auto-books low-risk orders with the default courier', async () => {
    const { call } = t.sellerClient('growth');
    await call('PUT', '/v1/couriers/steadfast', { credentials: { apiKey: 'k', secretKey: 's' } });
    await call('PATCH', '/v1/me', { autoBookCourier: 'steadfast' });
    const res = await call('POST', '/v1/orders', t.order('01712345678', { codAmount: 0 }));
    expect(res.json.order).toMatchObject({ status: 'booked', consignmentId: '987' });
  });

  it('shares return history across sellers and asks for an advance', async () => {
    const a = t.sellerClient('growth', 'Shop A');
    for (let i = 0; i < 2; i++) {
      const o = (await a.call('POST', '/v1/orders', t.order('01911223344'))).json.order;
      await a.call('POST', `/v1/orders/${o.id}/actions`, { action: 'confirm' });
      expect((await a.call('POST', `/v1/orders/${o.id}/outcome`, { outcome: 'returned' })).json.order.status).toBe('returned');
    }

    const b = t.sellerClient('growth', 'Shop B');
    await b.call('PATCH', '/v1/me', { bkashNumber: '+8801812345678', advanceFeeBdt: 120 });
    const risky = (await b.call('POST', '/v1/orders', t.order('01911223344'))).json.order;
    expect(risky.risk).toMatchObject({ level: 'high', action: 'advance_payment', deliverySuccessRate: 0 });
    expect(risky.status).toBe('awaiting_advance');
    expect(t.sms.sent.at(-1)!.text).toContain('অগ্রিম');

    const code = t.lastCode();
    const page = await (await t.app.request(`/c/${code}`)).text();
    expect(page).toContain('01812345678');
    expect(page).toContain('৳১২০');
    // The customer can't self-confirm without paying...
    expect(await (await t.customer(code, 'confirm')).text()).toContain('অগ্রিম পেমেন্টের পর');
    // ...the seller confirms once the bKash payment arrives.
    const paid = await b.call('POST', `/v1/orders/${risky.id}/actions`, { action: 'advance_received' });
    expect(paid.json.order.status).toBe('confirmed');
  });

  it('records customer cancellations and reports savings', async () => {
    const { call } = t.sellerClient('starter');
    const o = (await call('POST', '/v1/orders', t.order('01611112222'))).json.order;
    expect(await (await t.customer(t.lastCode(), 'cancel')).text()).toContain('বাতিল');
    expect((await call('GET', `/v1/orders/${o.id}`)).json.order.status).toBe('cancelled');

    const stats = (await call('GET', '/v1/stats')).json;
    expect(stats).toMatchObject({ totalOrders: 1, stoppedBeforeShipping: 1, estimatedSavedBdt: 150, rtoRate: null });

    // The cancellation counts against the number for everyone.
    const again = (await call('POST', '/v1/orders', t.order('01611112222'))).json.order;
    expect(again.risk.reasons.map((r: any) => r.code)).toContain('PAST_CANCELLATIONS');
  });

  it('expires confirmation links', async () => {
    const { call } = t.sellerClient('starter');
    await call('POST', '/v1/orders', t.order('01511112222'));
    const code = t.lastCode();
    t.clock.now = new Date(t.clock.now.getTime() + 49 * 3600_000);
    expect(await (await t.customer(code, 'confirm')).text()).toContain('মেয়াদ শেষ');
    expect((await t.app.request('/c/doesNotExist')).status).toBe(404);
  });

  it('holds blocked and invalid numbers without sending SMS', async () => {
    const { call } = t.sellerClient('starter');
    await call('POST', '/v1/blocklist', { phone: '01399998888', reason: 'fake orders' });
    expect((await call('POST', '/v1/orders', t.order('01399998888'))).json.order.status).toBe('on_hold');
    expect((await call('POST', '/v1/orders', t.order('01234567890'))).json.order).toMatchObject({ status: 'on_hold', phoneValid: false });
    expect(t.sms.sent).toHaveLength(0);
    expect((await call('DELETE', '/v1/blocklist/01399998888')).json.removed).toBe(true);
  });

  it('enforces plans', async () => {
    const free = t.sellerClient('free');
    expect((await free.call('POST', '/v1/orders', t.order('01712345678'))).status).toBe(402);
    expect((await free.call('PATCH', '/v1/me', { riskPolicy: { mediumAt: 40, highAt: 70, criticalAt: 90, advancePaymentEnabled: false } })).status).toBe(
      402,
    );

    const check = await free.call('POST', '/v1/customers/check', { phone: '01712345678' });
    expect(check.json).toMatchObject({ phone: '01712345678', valid: true, risk: { level: 'medium' } });
    for (let i = 1; i < 100; i++) await free.call('POST', '/v1/customers/check', { phone: '01712345678' });
    expect((await free.call('POST', '/v1/customers/check', { phone: '01712345678' })).status).toBe(402);
    expect((await free.call('GET', '/v1/usage')).json.usage.riskChecks).toBe(100);

    const starter = t.sellerClient('starter');
    expect((await starter.call('PUT', '/v1/couriers/steadfast', { credentials: { apiKey: 'k', secretKey: 's' } })).status).toBe(200);
    expect((await starter.call('PUT', '/v1/couriers/redx', { credentials: { accessToken: 't', pickupStoreId: 1 } })).status).toBe(402);
  });

  it('validates input and state', async () => {
    const { call } = t.sellerClient('growth');
    expect((await call('POST', '/v1/orders', { phone: '017' })).status).toBe(400);
    expect((await call('GET', '/v1/orders?status=bogus')).status).toBe(400);
    const o = (await call('POST', '/v1/orders', t.order('01712345678'))).json.order;
    expect((await call('POST', `/v1/orders/${o.id}/book`, { courier: 'steadfast' })).status).toBe(409);
    expect((await call('POST', `/v1/orders/${o.id}/outcome`, { outcome: 'delivered' })).status).toBe(409);
    expect((await call('GET', '/v1/orders/ord_nope')).status).toBe(404);
  });
});

describe('store webhooks', () => {
  const wooOrder = {
    id: 4512,
    total: '1450.00',
    payment_method: 'cod',
    billing: { first_name: 'Karim', last_name: 'Uddin', phone: '01712345678', address_1: 'House 1, Road 2, Mirpur', city: 'Dhaka' },
    line_items: [{ name: 'Panjabi', quantity: 1, price: 1450 }],
  };

  const post = (sellerId: string, secret: string | null, body: string, platform = 'woocommerce') =>
    t.app.request(`/webhooks/${platform}/${sellerId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { [platform === 'woocommerce' ? 'x-wc-webhook-signature' : 'x-shopify-hmac-sha256']: signBase64Hmac(secret, body) } : {}),
      },
      body,
    });

  it('imports signed WooCommerce orders exactly once', async () => {
    const { seller } = t.sellerClient('growth');
    const body = JSON.stringify(wooOrder);
    const first = await post(seller.id, seller.webhookSecret, body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ created: true, status: 'awaiting_confirmation' });
    expect(await (await post(seller.id, seller.webhookSecret, body)).json()).toMatchObject({ created: false });
    expect(t.sms.sent).toHaveLength(1);
  });

  it('rejects bad signatures, answers pings and gates by plan', async () => {
    const growth = t.sellerClient('growth').seller;
    expect((await post(growth.id, 'wrong-secret', JSON.stringify(wooOrder))).status).toBe(401);
    expect((await post(growth.id, null, 'webhook_id=12')).status).toBe(200);
    expect((await post('sel_unknown', 'x', '{}')).status).toBe(404);
    expect((await post(growth.id, growth.webhookSecret, '{"nope":true}')).status).toBe(422);

    const starter = t.sellerClient('starter').seller;
    expect((await post(starter.id, starter.webhookSecret, JSON.stringify(wooOrder))).status).toBe(402);
  });

  it('imports signed Shopify orders', async () => {
    const { seller } = t.sellerClient('scale');
    const body = JSON.stringify({
      id: 5550001,
      total_price: '2100.00',
      financial_status: 'pending',
      payment_gateway_names: ['Cash on Delivery (COD)'],
      shipping_address: { name: 'Nusrat Jahan', address1: 'Flat 4B, Road 11, Nasirabad', city: 'Chattogram', phone: '01811223344' },
      line_items: [{ title: 'Saree', quantity: 1, price: '2100.00' }],
    });
    const res = await post(seller.id, seller.webhookSecret, body, 'shopify');
    expect(await res.json()).toMatchObject({ created: true, status: 'awaiting_confirmation' });
  });
});

describe('public pages', () => {
  it('serves the landing page and health check', async () => {
    expect(await (await t.app.request('/')).text()).toContain('Nishchit');
    expect(await (await t.app.request('/health')).json()).toEqual({ ok: true });
  });
});
