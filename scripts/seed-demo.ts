/**
 * Fill a database with a realistic demo shop — for sales demos and UI work.
 *
 *   DATABASE_PATH=./data/demo.db npm run seed:demo
 *
 * Creates "Demo Fashion" (Growth plan, login phone 01700000000), shared network history from
 * other sellers, and orders in every state. Never run against a production database.
 */
import { loadConfig } from '../src/config.js';
import { buildService } from '../src/main.js';
import type { OrderInput } from '../src/domain/types.js';

const config = loadConfig();
if (config.nodeEnv === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
const { service, store } = buildService(config);

const ADDRESSES = [
  'House 12, Road 5, Dhanmondi, Dhaka',
  'Flat 4B, Road 11, Nasirabad, Chattogram',
  'Holding 33, Zindabazar, Sylhet Sadar, Sylhet',
  'Bari 7, Shaheb Bazar, Rajshahi Sadar, Rajshahi',
  'House 3, Sector 7, Uttara, Dhaka',
];
const order = (name: string, phone: string, amount: number, i: number, extra: Partial<OrderInput> = {}): OrderInput => ({
  source: 'manual',
  customerName: name,
  phone,
  address: ADDRESSES[i % ADDRESSES.length]!,
  district: ADDRESSES[i % ADDRESSES.length]!.split(', ').at(-1),
  codAmount: amount,
  items: [{ name: ['Panjabi', 'Three-piece', 'Saree', 'Kurti', 'Shirt'][i % 5]!, quantity: 1, unitPrice: amount }],
  ...extra,
});

async function main() {
  // Other sellers build up network history.
  const others = [0, 1, 2].map((i) => service.createSeller({ name: `Peer ${i}`, shopName: `Peer Shop ${i}`, plan: 'growth' }).seller);
  const history: Array<[string, 'delivered' | 'returned', number]> = [
    ['01811223344', 'delivered', 4],
    ['01911002200', 'returned', 1],
    ['01611987654', 'returned', 1],
    ['01511443322', 'delivered', 2],
  ];
  for (const [phone, outcome, n] of history) {
    for (let k = 0; k < n; k++) {
      for (const peer of outcome === 'returned' ? others : [others[0]!]) {
        const { order: o } = await service.createOrder(peer, order('Peer customer', phone, 1200, k));
        if (o.status !== 'confirmed') await service.sellerAction(peer, o.id, 'confirm');
        service.recordOutcome(peer, o.id, outcome);
      }
    }
  }

  // That history happened weeks ago, not today (otherwise it looks like an order burst).
  for (const peer of others) {
    store.db
      .prepare(`UPDATE orders SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (abs(random()) % 50 + 10) || ' days') WHERE seller_id = ?`)
      .run(peer.id);
  }

  const { seller, apiKey } = service.createSeller({ name: 'Demo Owner', shopName: 'Demo Fashion', plan: 'growth', phone: '01700000000' });
  service.updateSettings(seller, { bkashNumber: '01800000000', advanceFeeBdt: 130 });
  service.blockPhone(seller, '01399998888', 'বারবার ভুয়া অর্ডার');

  const shop = service.findSeller(seller.id)!;
  const make = (name: string, phone: string, amount: number, i: number, extra?: Partial<OrderInput>) =>
    service.createOrder(shop, order(name, phone, amount, i, extra)).then((r) => r.order);

  const delivered = await make('Nusrat Jahan', '01811223344', 2100, 1);
  service.recordOutcome(shop, delivered.id, 'delivered');
  const returned = await make('Sabbir Ahmed', '01722334455', 1650, 2);
  await service.sellerAction(shop, returned.id, 'confirm');
  service.recordOutcome(shop, returned.id, 'returned');
  for (const [i, name] of ['Tania Akter', 'Rafiq Hasan'].entries()) {
    const o = await make(name, `0177${i}111222`, 1350 + i * 200, i + 3);
    await service.customerRespond(o.confirmCode!, 'cancel');
  }
  const d2 = await make('Mahmud Karim', '01511443322', 990, 4);
  service.recordOutcome(shop, d2.id, 'delivered');

  await make('Karim Uddin', '01712345678', 1450, 0); // awaiting confirmation
  await make('Ayesha Siddiqua', '01822446688', 2450, 1); // awaiting confirmation
  await make('Jamal Hossain', '01911002200', 3200, 2); // returns to 3 sellers -> hold
  await make('Shirin Sultana', '01611987654', 1800, 3, { address: 'Mirpur' }); // returns + vague -> hold
  await make('Faruk Mia', '01399998888', 1200, 4); // blocked -> hold
  await make('Prepaid Rina', '01755667788', 0, 0); // prepaid -> confirmed
  await make('Nasima Begum', '01811223344', 1750, 1); // good history -> confirmed

  store.close();
  console.log(`
Demo shop ready: Demo Fashion (Growth)
  Dashboard login phone: 01700000000  (the code is printed by the console SMS provider)
  API key:               ${apiKey}
`);
}

await main();
