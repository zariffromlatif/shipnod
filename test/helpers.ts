import { SslCommerzClient } from '../src/billing/sslcommerz.js';
import { ConsoleSmsProvider } from '../src/confirmation/sms.js';
import { BillingRepo } from '../src/db/billing-repo.js';
import { Store } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import { SecretBox } from '../src/lib/crypto.js';
import { AuthService } from '../src/services/auth.js';
import { BillingService } from '../src/services/billing.js';
import { ShipnodService } from '../src/services/shipnod.js';

export const ADMIN_PASSWORD = 'correct-horse-battery-staple';

export interface HarnessOptions {
  /** Configure SSLCommerz (default true). */
  sslcommerz?: boolean;
  /** Configure manual bKash/Nagad numbers (default true). */
  manual?: boolean;
  /** Enable /admin (default true). */
  admin?: boolean;
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
  const app = createApp(
    { service, auth, billing, billingRepo },
    { publicBaseUrl: 'https://nsc.test', secureCookies: false, adminPassword: opts.admin === false ? null : ADMIN_PASSWORD, now },
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

  return { store, sms, service, auth, billing, billingRepo, app, clock, courier, gateway, validPayment };
}
