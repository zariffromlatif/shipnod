import type { Hono } from 'hono';
import { SslCommerzClient } from '../src/billing/sslcommerz.js';
import { ConsoleSmsProvider } from '../src/confirmation/sms.js';
import { BillingRepo } from '../src/db/billing-repo.js';
import { Store } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import { SecretBox } from '../src/lib/crypto.js';
import { AuthService } from '../src/services/auth.js';
import { BillingService } from '../src/services/billing.js';
import { OnboardingService } from '../src/services/onboarding.js';
import { LeadRepo } from '../src/db/leads-repo.js';
import { LeadService } from '../src/services/leads.js';
import { ShipnodService } from '../src/services/shipnod.js';

export const ADMIN_PASSWORD = 'correct-horse-battery-staple';
export const LEAD_ALERT_PHONE = '01999999999';
export const SUPPORT_WHATSAPP = '01888888888';

export interface HarnessOptions {
  /** Configure SSLCommerz (default true). */
  sslcommerz?: boolean;
  /** Configure manual bKash/Nagad numbers (default true). */
  manual?: boolean;
  /** Enable /admin (default true). */
  admin?: boolean;
  /** Configure the support WhatsApp number (default true). */
  whatsapp?: boolean;
}

/**
 * In-memory app with fake Steadfast and SSLCommerz APIs and a controllable clock (14:00 Dhaka by default).
 * `gateway.validations[val_id]` sets what SSLCommerz's validation API answers for that val_id.
 */
export function createHarness(opts: HarnessOptions = {}) {
  const store = new Store(':memory:');
  const sms = new ConsoleSmsProvider(true);
  const courier = { deliveryStatus: 'pending', calls: [] as string[] };
  const gateway = {
    sessions: [] as Array<Record<string, string>>,
    validations: {} as Record<string, Record<string, unknown>>,
    validateCalls: 0,
    initFails: false,
  };

  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes('sslcommerz.com/gwprocess/v4/api.php')) {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      gateway.sessions.push(body);
      if (gateway.initFails) return Response.json({ status: 'FAILED', failedreason: 'Store is inactive' });
      return Response.json({ status: 'SUCCESS', sessionkey: 'SESS1', GatewayPageURL: `https://sandbox.sslcommerz.com/EasyCheckOut/test${body.tran_id}` });
    }
    if (url.includes('sslcommerz.com/validator/api/validationserverAPI.php')) {
      gateway.validateCalls++;
      const valId = new URL(url).searchParams.get('val_id') ?? '';
      return Response.json(gateway.validations[valId] ?? { status: 'INVALID_TRANSACTION' });
    }
    courier.calls.push(url);
    if (url.endsWith('/create_order')) {
      return Response.json({ status: 200, consignment: { consignment_id: 987, tracking_code: 'SF987', status: 'in_review' } });
    }
    if (url.includes('/status_by_cid/')) return Response.json({ status: 200, delivery_status: courier.deliveryStatus });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const clock = { now: new Date() };
  clock.now.setUTCHours(8, 0, 0, 0); // 14:00 in Dhaka: keeps LATE_NIGHT out of the scores
  const now = () => clock.now;

  const service = new ShipnodService({
    store,
    sms,
    secretBox: new SecretBox('cd'.repeat(32)),
    networkHashSecret: 'test-network-secret-at-least-32-characters',
    publicBaseUrl: 'https://nsc.test',
    confirmTtlHours: 48,
    courierSandbox: true,
    fetch: fakeFetch,
    now,
  });
  const auth = new AuthService({ store, sms, service, now });
  const billingRepo = new BillingRepo(store.db);
  const billing = new BillingService({
    store,
    repo: billingRepo,
    sms,
    publicBaseUrl: 'https://nsc.test',
    sslcommerz: opts.sslcommerz === false ? null : new SslCommerzClient({ storeId: 'testbox', storePassword: 'qwerty', sandbox: true, fetch: fakeFetch }),
    manual: opts.manual === false ? { bkash: null, nagad: null } : { bkash: '01900000001', nagad: '01600000001' },
    now,
  });
  const onboarding = new OnboardingService({ service, billing, sms, publicBaseUrl: 'https://nsc.test' });
  const leads = new LeadService({ repo: new LeadRepo(store.db), service, sms, publicBaseUrl: 'https://nsc.test', alertPhone: LEAD_ALERT_PHONE, now });
  const app = createApp(
    { service, auth, billing, billingRepo, onboarding, leads },
    {
      publicBaseUrl: 'https://nsc.test',
      secureCookies: false,
      adminPassword: opts.admin === false ? null : ADMIN_PASSWORD,
      supportWhatsapp: opts.whatsapp === false ? null : SUPPORT_WHATSAPP,
      now,
    },
  );

  /** A successful SSLCommerz validation answer for a payment. */
  const validPayment = (tranId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    status: 'VALID',
    tran_id: tranId,
    val_id: `VAL-${tranId}`,
    amount: amount.toFixed(2),
    currency: 'BDT',
    bank_tran_id: `BANK-${tranId}`,
    card_type: 'BKASH-BKash',
    risk_level: '0',
    ...extra,
  });

  return { store, sms, service, auth, billing, billingRepo, onboarding, leads, app, clock, courier, gateway, validPayment };
}

/** Cookie-keeping client; picks up the CSRF token from the last HTML page. */
export function client(app: Hono<any>) {
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
