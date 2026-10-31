import { readFileSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import { planOf } from '../billing/plans.js';
import type { Seller } from '../db/store.js';
import { InvalidTransitionError } from '../domain/order-state.js';
import { COURIER_IDS, ORDER_STATUSES, type OrderInput } from '../domain/types.js';
import { mapShopifyOrder, verifyShopifySignature } from '../integrations/shopify.js';
import { mapWooOrder, verifyWooSignature } from '../integrations/woocommerce.js';
import { AppError } from '../lib/errors.js';
import type { ShipnodService } from '../services/shipnod.js';
import { confirmationPage, notFoundPage } from './pages.js';

type Env = { Variables: { seller: Seller } };

const orderItem = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().positive().max(1000),
  unitPrice: z.number().nonnegative(),
});

const createOrderBody = z.object({
  externalId: z.string().max(100).optional(),
  customerName: z.string().min(1).max(120),
  phone: z.string().min(6).max(30),
  address: z.string().min(1).max(500),
  district: z.string().max(80).optional(),
  codAmount: z.number().nonnegative().max(1_000_000),
  items: z.array(orderItem).max(100).default([]),
  note: z.string().max(500).optional(),
  placedAt: z.coerce.date().optional(),
});

const checkBody = z.object({
  phone: z.string().min(6).max(30),
  codAmount: z.number().nonnegative().optional(),
  address: z.string().max(500).optional(),
});

const riskPolicyBody = z
  .object({
    mediumAt: z.number().int().min(1).max(100),
    highAt: z.number().int().min(1).max(100),
    criticalAt: z.number().int().min(1).max(101),
    advancePaymentEnabled: z.boolean(),
  })
  .refine((p) => p.mediumAt < p.highAt && p.highAt < p.criticalAt, 'Thresholds must increase: mediumAt < highAt < criticalAt');

const settingsBody = z
  .object({
    shopName: z.string().min(1).max(60),
    smsLang: z.enum(['bn', 'banglish', 'en']),
    advanceFeeBdt: z.number().int().min(0).max(1000),
    bkashNumber: z.string().max(20).nullable(),
    autoBookCourier: z.enum(COURIER_IDS).nullable(),
    costPerFailedOrderBdt: z.number().int().min(0).max(5000),
    riskPolicy: riskPolicyBody.nullable(),
  })
  .partial();

const actionBody = z.object({
  action: z.enum(['confirm', 'cancel', 'hold', 'advance_received']),
  customerRefused: z.boolean().optional(),
});

const bookBody = z.object({
  courier: z.enum(COURIER_IDS).optional(),
  weightKg: z.number().positive().max(30).optional(),
  area: z
    .object({
      cityId: z.number().int().optional(),
      zoneId: z.number().int().optional(),
      areaId: z.number().int().optional(),
      areaName: z.string().optional(),
    })
    .optional(),
});

function loadLanding(): string {
  try {
    return readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  } catch {
    return '<!doctype html><title>Shipnod</title><p>Shipnod API</p>';
  }
}

async function jsonBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body must be JSON');
  }
  return schema.parse(raw);
}

export function createApp(service: ShipnodService): Hono<Env> {
  const app = new Hono<Env>();
  const landing = loadLanding();

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof ZodError) {
      return c.json({ error: { code: 'validation_error', message: 'Invalid request', issues: err.issues } }, 400);
    }
    if (err instanceof InvalidTransitionError) return c.json({ error: { code: 'invalid_state', message: err.message } }, 409);
    console.error(err);
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/', (c) => c.html(landing));

  // ------------------------------------------------ customer confirmation link

  app.get('/c/:code', (c) => {
    const code = c.req.param('code');
    const found = service.getConfirmation(code);
    if (!found) return c.html(notFoundPage(), 404);
    return c.html(confirmationPage({ ...found, code }));
  });

  app.post('/c/:code', async (c) => {
    const code = c.req.param('code');
    const form = await c.req.parseBody();
    const decision = form.decision === 'cancel' ? 'cancel' : 'confirm';
    try {
      await service.customerRespond(code, decision);
    } catch (err) {
      if (!(err instanceof AppError) || err.status === 404) {
        if (err instanceof AppError) return c.html(notFoundPage(), 404);
        throw err;
      }
      const found = service.getConfirmation(code)!;
      return c.html(confirmationPage({ ...found, code, error: err.code === 'advance_required' ? 'অগ্রিম পেমেন্টের পর বিক্রেতা অর্ডারটি নিশ্চিত করবেন।' : undefined }));
    }
    const found = service.getConfirmation(code)!;
    return c.html(confirmationPage({ ...found, code }));
  });

  // ------------------------------------------------------- store webhooks

  app.post('/webhooks/:platform{woocommerce|shopify}/:sellerId', async (c) => {
    const platform = c.req.param('platform') as 'woocommerce' | 'shopify';
    const seller = service.findSeller(c.req.param('sellerId'));
    if (!seller) throw new AppError(404, 'not_found', 'Unknown seller');
    const raw = await c.req.text();

    const signature =
      platform === 'woocommerce' ? c.req.header('x-wc-webhook-signature') : c.req.header('x-shopify-hmac-sha256');
    // WooCommerce sends an unsigned form-encoded ping ("webhook_id=…") when a webhook is created.
    if (platform === 'woocommerce' && !signature && raw.startsWith('webhook_id=')) return c.json({ ok: true, ping: true });
    const valid =
      platform === 'woocommerce'
        ? verifyWooSignature(seller.webhookSecret, raw, signature)
        : verifyShopifySignature(seller.webhookSecret, raw, signature);
    if (!valid) throw new AppError(401, 'bad_signature', 'Webhook signature mismatch');

    if (!planOf(seller.plan).storeIntegrations) {
      throw new AppError(402, 'plan_required', 'Store integrations need the Growth plan or above');
    }
    let input: OrderInput;
    try {
      const parsed: unknown = JSON.parse(raw);
      input = platform === 'woocommerce' ? mapWooOrder(parsed) : mapShopifyOrder(parsed);
    } catch (err) {
      if (err instanceof ZodError || err instanceof SyntaxError) throw new AppError(422, 'unprocessable', 'Unrecognised order payload');
      throw err;
    }
    const { order, created } = await service.createOrder(seller, input);
    return c.json({ ok: true, orderId: order.id, created, status: order.status });
  });

  // ------------------------------------------------------------ seller API

  const api = new Hono<Env>();

  api.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const seller = key ? service.authenticate(key) : null;
    if (!seller) throw new AppError(401, 'unauthorized', 'Missing or invalid API key');
    c.set('seller', seller);
    await next();
  });

  api.get('/me', (c) => {
    const s = c.get('seller');
    return c.json({
      seller: s,
      plan: planOf(s.plan),
      webhooks: {
        woocommerce: `/webhooks/woocommerce/${s.id}`,
        shopify: `/webhooks/shopify/${s.id}`,
      },
    });
  });

  api.patch('/me', async (c) => {
    const seller = c.get('seller');
    const body = await jsonBody(c, settingsBody);
    return c.json({ seller: service.updateSettings(seller, body) });
  });

  api.post('/customers/check', async (c) => {
    const body = await jsonBody(c, checkBody);
    return c.json(service.checkCustomer(c.get('seller'), body));
  });

  api.post('/orders', async (c) => {
    const body = await jsonBody(c, createOrderBody);
    const { order, created } = await service.createOrder(c.get('seller'), { ...body, source: 'api' });
    return c.json({ order, created }, created ? 201 : 200);
  });

  api.get('/orders', (c) => {
    const status = c.req.query('status');
    if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, 'invalid_status', `status must be one of ${ORDER_STATUSES.join(', ')}`);
    }
    const orders = service.listOrders(c.get('seller'), {
      status: status as (typeof ORDER_STATUSES)[number] | undefined,
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    });
    return c.json({ orders });
  });

  api.get('/orders/:id', (c) => c.json(service.getOrder(c.get('seller'), c.req.param('id'))));

  api.post('/orders/:id/actions', async (c) => {
    const body = await jsonBody(c, actionBody);
    const order = await service.sellerAction(c.get('seller'), c.req.param('id'), body.action, {
      customerRefused: body.customerRefused,
    });
    return c.json({ order });
  });

  api.post('/orders/:id/resend', async (c) => {
    return c.json({ order: await service.resendConfirmation(c.get('seller'), c.req.param('id')) });
  });

  api.post('/orders/:id/book', async (c) => {
    const body = await jsonBody(c, bookBody);
    return c.json({ order: await service.bookCourier(c.get('seller'), c.req.param('id'), body) });
  });

  api.post('/orders/:id/outcome', async (c) => {
    const body = await jsonBody(c, z.object({ outcome: z.enum(['delivered', 'returned']) }));
    return c.json({ order: service.recordOutcome(c.get('seller'), c.req.param('id'), body.outcome) });
  });

  api.get('/couriers', (c) => c.json({ connected: service.listCouriers(c.get('seller')) }));

  api.put('/couriers/:courier', async (c) => {
    const courier = z.enum(COURIER_IDS).parse(c.req.param('courier'));
    const body = await jsonBody(c, z.object({ credentials: z.record(z.unknown()) }));
    return c.json({ connected: service.connectCourier(c.get('seller'), courier, body.credentials) });
  });

  api.post('/blocklist', async (c) => {
    const body = await jsonBody(c, z.object({ phone: z.string(), reason: z.string().max(200).optional() }));
    service.blockPhone(c.get('seller'), body.phone, body.reason ?? null);
    return c.json({ ok: true });
  });

  api.delete('/blocklist/:phone', (c) => c.json({ removed: service.unblockPhone(c.get('seller'), c.req.param('phone')) }));

  api.get('/stats', (c) => {
    const days = z.coerce.number().int().min(1).max(365).default(30).parse(c.req.query('days') ?? undefined);
    return c.json(service.stats(c.get('seller'), days));
  });

  api.get('/usage', (c) => c.json(service.usage(c.get('seller'))));

  app.route('/v1', api);
  return app;
}

