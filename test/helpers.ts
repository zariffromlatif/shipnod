import { ConsoleSmsProvider } from '../src/confirmation/sms.js';
import { Store } from '../src/db/store.js';
import { createApp } from '../src/http/app.js';
import { SecretBox } from '../src/lib/crypto.js';
import { AuthService } from '../src/services/auth.js';
import { ShipnodService } from '../src/services/shipnod.js';

/** In-memory app with a fake Steadfast API and a controllable clock (14:00 Dhaka by default). */
export function createHarness() {
  const store = new Store(':memory:');
  const sms = new ConsoleSmsProvider(true);
  const courier = { deliveryStatus: 'pending', calls: [] as string[] };
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
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
  const app = createApp(service, auth, { publicBaseUrl: 'https://nsc.test', secureCookies: false, now });
  return { store, sms, service, auth, app, clock, courier };
}
