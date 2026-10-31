import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z, ZodError } from 'zod';
import { planOf } from '../../billing/plans.js';
import type { Seller } from '../../db/store.js';
import { InvalidTransitionError } from '../../domain/order-state.js';
import { COURIER_IDS, type OrderItem, type RiskLevel } from '../../domain/types.js';
import { AppError } from '../../lib/errors.js';
import { CYCLES, nextPaidUntil, type Cycle } from '../../billing/subscription.js';
import { SESSION_TTL_DAYS, type AuthService } from '../../services/auth.js';
import type { BillingService } from '../../services/billing.js';
import { BILLING_MESSAGES, billingPage, invoicePage } from './billing-views.js';
import type { SellerAction, ShipnodService } from '../../services/shipnod.js';
import {
  checkPage,
  loginPage,
  newOrderPage,
  orderDetailPage,
  ORDER_TABS,
  ordersPage,
  overviewPage,
  settingsPage,
  SUCCESS_MESSAGES,
  verifyPage,
  type NewOrderValues,
  type OrderTab,
} from './views.js';

const COOKIE = 'shipnod_session';
const PAGE_SIZE = 25;

type DashEnv = { Variables: { seller: Seller; session: string; csrf: string } };

export interface DashboardOptions {
  publicBaseUrl: string;
  /** Mark the session cookie Secure (production, HTTPS). */
  secureCookies: boolean;
  now?: () => Date;
}

type Form = Record<string, string | File>;
const field = (form: Form, key: string): string => {
  const v = form[key];
  return typeof v === 'string' ? v.trim() : '';
};
const optionalInt = (form: Form, key: string): number | undefined => {
  const v = field(form, key);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

/** Turns service errors into a sentence a seller can act on. */
function errorMessage(err: unknown): string | null {
  if (err instanceof InvalidTransitionError) return 'এই অবস্থায় অর্ডারটিতে এটি করা যাবে না। পাতা রিফ্রেশ করে দেখুন।';
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return `তথ্য সঠিক নয়${first ? `: ${first.path.join('.') || 'input'} — ${first.message}` : ''}`;
  }
  if (!(err instanceof AppError)) return null;
  switch (err.code) {
    case 'courier_not_connected':
      return 'আগে সেটিংসে এই কুরিয়ার যুক্ত করুন।';
    case 'courier_required':
      return 'একটি কুরিয়ার বেছে নিন।';
    case 'courier_error':
      return `কুরিয়ার বুকিং হয়নি: ${err.message}`;
    case 'invalid_phone':
      return 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন।';
    case 'quota_exceeded':
      return 'এই মাসের কাস্টমার চেকের সীমা শেষ। প্ল্যান আপগ্রেড করুন।';
    case 'plan_required':
    case 'plan_limit':
      return `আপনার প্ল্যানে এটি নেই — ${err.message}`;
    case 'already_paid':
      return 'এই ইনভয়েস আগেই পরিশোধ করা হয়েছে।';
    case 'invoice_expired':
      return 'এই ইনভয়েসের মেয়াদ শেষ। বিলিং পাতা থেকে নতুন করে নিন।';
    case 'online_unavailable':
      return 'অনলাইন পেমেন্ট এখনো চালু হয়নি। Send Money করে পেমেন্ট করুন।';
    case 'invalid_reference':
      return 'bKash/Nagad মেসেজে আসা Transaction ID (TrxID) ঠিকভাবে লিখুন।';
    case 'duplicate_reference':
      return 'এই Transaction ID আগেই জমা দেওয়া হয়েছে।';
    case 'already_submitted':
      return 'এই ইনভয়েসের একটি পেমেন্ট আগেই যাচাইয়ের অপেক্ষায় আছে।';
    case 'payment_provider_error':
      return 'পেমেন্ট গেটওয়েতে সমস্যা হয়েছে। একটু পর আবার চেষ্টা করুন অথবা Send Money করুন।';
    default:
      return err.message;
  }
}

export function createDashboard(service: ShipnodService, auth: AuthService, billing: BillingService, opts: DashboardOptions): Hono<DashEnv> {
  const app = new Hono<DashEnv>();
  const now = opts.now ?? (() => new Date());

  const startSession = (c: Context, token: string) => {
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: 'Lax',
      path: '/app',
      maxAge: SESSION_TTL_DAYS * 86400,
    });
    return c.redirect('/app', 303);
  };

  // ----------------------------------------------------------------- public: login

  app.get('/login', (c) => (auth.sessionSeller(getCookie(c, COOKIE)) ? c.redirect('/app') : c.html(loginPage({}))));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const phoneInput = field(form, 'phone');
    const result = await auth.requestLoginCode(phoneInput);
    if (result.status === 'invalid_phone') {
      return c.html(loginPage({ phone: phoneInput, error: 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন।' }), 400);
    }
    const notice =
      result.status === 'rate_limited'
        ? `একটু আগেই কোড পাঠানো হয়েছে। নতুন কোডের জন্য ${result.retryAfterSeconds >= 3600 ? '১ ঘণ্টা' : `${result.retryAfterSeconds} সেকেন্ড`} অপেক্ষা করুন, অথবা আগের কোডটি দিন।`
        : undefined;
    return c.html(verifyPage({ phone: result.phone, notice }));
  });

  app.post('/login/verify', async (c) => {
    const form = await c.req.parseBody();
    const phone = field(form, 'phone');
    const result = auth.verifyLoginCode(phone, field(form, 'code'));
    if (result.status === 'ok') return startSession(c, result.token);
    const error = {
      invalid: 'কোডটি সঠিক নয়।',
      expired: 'কোডের মেয়াদ শেষ। নতুন কোড নিন।',
      too_many_attempts: 'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড নিন।',
    }[result.status];
    return c.html(verifyPage({ phone, error }), 401);
  });

  app.post('/login/key', async (c) => {
    const form = await c.req.parseBody();
    const result = auth.loginWithApiKey(field(form, 'apiKey'));
    if (!result) return c.html(loginPage({ error: 'API key সঠিক নয়।' }), 401);
    return startSession(c, result.token);
  });

  // ------------------------------------------------------------ session guard

  app.use('*', async (c, next) => {
    const token = getCookie(c, COOKIE);
    const seller = auth.sessionSeller(token);
    if (!seller || !token) {
      if (token) deleteCookie(c, COOKIE, { path: '/app' });
      return c.redirect('/app/login', 303);
    }
    if (c.req.method === 'POST') {
      const form = await c.req.parseBody();
      if (!auth.verifyCsrf(token, form._csrf)) return c.text('Invalid or missing form token. Reload the page and try again.', 403);
    }
    c.set('seller', seller);
    c.set('session', token);
    c.set('csrf', auth.csrfToken(token));
    await next();
  });

  app.post('/logout', (c) => {
    auth.logout(c.get('session'));
    deleteCookie(c, COOKIE, { path: '/app' });
    return c.redirect('/app/login', 303);
  });

  // ------------------------------------------------------------------ overview

  app.get('/', (c) => {
    const seller = c.get('seller');
    return c.html(
      overviewPage({
        seller,
        csrf: c.get('csrf'), now: now(),
        stats: service.stats(seller, 30),
        counts: service.orderCounts(seller),
        usage: service.usage(seller),
        recent: service.listOrders(seller, { limit: 8 }),
      }),
    );
  });

  // -------------------------------------------------------------------- orders

  app.get('/orders', (c) => {
    const seller = c.get('seller');
    const tabParam = c.req.query('tab') ?? 'all';
    const tab: OrderTab = tabParam in ORDER_TABS ? (tabParam as OrderTab) : 'all';
    const levelParam = c.req.query('level') ?? '';
    const level = (['low', 'medium', 'high', 'critical'] as const).includes(levelParam as RiskLevel) ? (levelParam as RiskLevel) : null;
    const search = (c.req.query('q') ?? '').trim().slice(0, 60);
    const pageNo = Math.max(1, Math.min(1000, Number(c.req.query('page')) || 1));
    const rows = service.listOrders(seller, {
      statuses: ORDER_TABS[tab].statuses,
      level: level ?? undefined,
      search: search || undefined,
      limit: PAGE_SIZE + 1,
      offset: (pageNo - 1) * PAGE_SIZE,
    });
    return c.html(
      ordersPage({
        seller,
        csrf: c.get('csrf'), now: now(),
        orders: rows.slice(0, PAGE_SIZE),
        tab,
        level,
        search,
        counts: service.orderCounts(seller),
        page: pageNo,
        hasNext: rows.length > PAGE_SIZE,
      }),
    );
  });

  app.get('/orders/new', (c) => c.html(newOrderPage({ seller: c.get('seller'), csrf: c.get('csrf'), now: now() })));

  app.post('/orders/new', async (c) => {
    const seller = c.get('seller');
    const form = await c.req.parseBody();
    const values: NewOrderValues = {
      customerName: field(form, 'customerName'),
      phone: field(form, 'phone'),
      address: field(form, 'address'),
      district: field(form, 'district'),
      codAmount: field(form, 'codAmount'),
      note: field(form, 'note'),
      items: [0, 1, 2].map((i) => ({
        name: field(form, `item${i}name`),
        quantity: field(form, `item${i}qty`),
        unitPrice: field(form, `item${i}price`),
      })),
    };
    const fail = (error: string) => c.html(newOrderPage({ seller, csrf: c.get('csrf'), now: now(), values, error }), 422);

    const amount = Number(values.codAmount);
    if (!values.customerName || !values.phone || !values.address) return fail('নাম, মোবাইল নম্বর আর ঠিকানা দিন।');
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return fail('ডেলিভারিতে নেওয়ার টাকা সঠিকভাবে লিখুন (অগ্রিম পেলে 0)।');
    const items: OrderItem[] = [];
    for (const it of values.items ?? []) {
      if (!it.name) continue;
      const quantity = Number(it.quantity || '1');
      const unitPrice = Number(it.unitPrice || '0');
      if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        return fail(`"${it.name}" — পরিমাণ ও দাম সঠিকভাবে লিখুন।`);
      }
      items.push({ name: it.name.slice(0, 200), quantity, unitPrice });
    }

    try {
      const { order } = await service.createOrder(seller, {
        source: 'manual',
        customerName: values.customerName.slice(0, 120),
        phone: values.phone,
        address: values.address.slice(0, 500),
        district: values.district || undefined,
        codAmount: amount,
        items,
        note: values.note || undefined,
      });
      return c.redirect(`/app/orders/${order.id}?msg=created`, 303);
    } catch (err) {
      const message = errorMessage(err);
      if (message) return fail(message);
      throw err;
    }
  });

  const renderOrder = (c: Context<DashEnv>, orderId: string, extra: { message?: string; error?: string; justCreated?: boolean; status?: 200 | 422 } = {}) => {
    const seller = c.get('seller');
    const { order, events } = service.getOrder(seller, orderId);
    return c.html(
      orderDetailPage({ seller, csrf: c.get('csrf'), now: now(), order, events, couriers: service.listCouriers(seller), ...extra }),
      extra.status ?? 200,
    );
  };

  app.get('/orders/:id', (c) => {
    const msg = c.req.query('msg');
    try {
      return renderOrder(c, c.req.param('id'), { message: msg ? SUCCESS_MESSAGES[msg] : undefined, justCreated: msg === 'created' });
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return c.text('Order not found', 404);
      throw err;
    }
  });

  app.post('/orders/:id', async (c) => {
    const seller = c.get('seller');
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const op = field(form, 'op');
    try {
      switch (op) {
        case 'confirm':
        case 'advance_received':
        case 'hold':
          await service.sellerAction(seller, id, op as SellerAction);
          break;
        case 'cancel':
          await service.sellerAction(seller, id, 'cancel', { customerRefused: field(form, 'customerRefused') === '1' });
          break;
        case 'resend':
          await service.resendConfirmation(seller, id);
          break;
        case 'book': {
          const courier = z.enum(COURIER_IDS).parse(field(form, 'courier'));
          const weight = Number(field(form, 'weightKg') || '0.5');
          await service.bookCourier(seller, id, {
            courier,
            weightKg: Number.isFinite(weight) && weight > 0 && weight <= 30 ? weight : 0.5,
            area: {
              cityId: optionalInt(form, 'cityId'),
              zoneId: optionalInt(form, 'zoneId'),
              areaId: optionalInt(form, 'areaId'),
              areaName: field(form, 'areaName') || undefined,
            },
          });
          break;
        }
        case 'delivered':
        case 'returned':
          service.recordOutcome(seller, id, op);
          break;
        default:
          return renderOrder(c, id, { error: 'অজানা অ্যাকশন।', status: 422 });
      }
      return c.redirect(`/app/orders/${id}?msg=${op}`, 303);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return c.text('Order not found', 404);
      const message = errorMessage(err);
      if (message) return renderOrder(c, id, { error: message, status: 422 });
      throw err;
    }
  });

  // ------------------------------------------------------------ customer check

  app.get('/check', (c) => c.html(checkPage({ seller: c.get('seller'), csrf: c.get('csrf'), now: now() })));

  app.post('/check', async (c) => {
    const seller = c.get('seller');
    const form = await c.req.parseBody();
    const phone = field(form, 'phone');
    const amount = Number(field(form, 'codAmount'));
    try {
      const result = service.checkCustomer(seller, { phone, codAmount: Number.isFinite(amount) && amount > 0 ? amount : undefined });
      return c.html(checkPage({ seller, csrf: c.get('csrf'), now: now(), phone, result }));
    } catch (err) {
      const message = errorMessage(err);
      if (message) return c.html(checkPage({ seller, csrf: c.get('csrf'), now: now(), phone, error: message }), 422);
      throw err;
    }
  });

  // ------------------------------------------------------------------ settings

  const renderSettings = (c: Context<DashEnv>, extra: { message?: string; error?: string; status?: 200 | 422 } = {}) => {
    const seller = c.get('seller');
    const { plan, ...usage } = service.usage(seller);
    return c.html(
      settingsPage({
        seller,
        csrf: c.get('csrf'), now: now(),
        plan,
        usage,
        couriers: service.listCouriers(seller),
        blocklist: service.listBlocklist(seller),
        publicBaseUrl: opts.publicBaseUrl,
        message: extra.message,
        error: extra.error,
      }),
      extra.status ?? 200,
    );
  };

  app.get('/settings', (c) => {
    const msg = c.req.query('msg');
    return renderSettings(c, { message: msg ? SUCCESS_MESSAGES[msg] : undefined });
  });

  const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

  app.post('/settings', async (c) => {
    const seller = c.get('seller');
    const form = await c.req.parseBody();
    const op = field(form, 'op');
    try {
      switch (op) {
        case 'profile': {
          const connected = service.listCouriers(seller);
          const autoBook = field(form, 'autoBookCourier');
          if (autoBook && !connected.includes(autoBook as never)) throw new AppError(422, 'courier_not_connected', 'courier not connected');
          service.updateSettings(seller, {
            shopName: z.string().min(1).max(60).parse(field(form, 'shopName')),
            smsLang: z.enum(['bn', 'banglish', 'en']).parse(field(form, 'smsLang') || seller.smsLang),
            advanceFeeBdt: intIn(0, 1000).parse(field(form, 'advanceFeeBdt')),
            costPerFailedOrderBdt: intIn(0, 5000).parse(field(form, 'costPerFailedOrderBdt')),
            bkashNumber: field(form, 'bkashNumber') || null,
            autoBookCourier: autoBook ? z.enum(COURIER_IDS).parse(autoBook) : null,
          });
          break;
        }
        case 'risk': {
          if (field(form, 'reset') === '1') {
            service.updateSettings(seller, { riskPolicy: null });
            break;
          }
          const policy = {
            mediumAt: intIn(1, 100).parse(field(form, 'mediumAt')),
            highAt: intIn(1, 100).parse(field(form, 'highAt')),
            criticalAt: intIn(1, 101).parse(field(form, 'criticalAt')),
            advancePaymentEnabled: field(form, 'advancePaymentEnabled') === '1',
          };
          if (!(policy.mediumAt < policy.highAt && policy.highAt < policy.criticalAt)) {
            return renderSettings(c, { error: 'সীমাগুলো বাড়তি ক্রমে দিন: মাঝারি < বেশি < খুব বেশি।', status: 422 });
          }
          service.updateSettings(seller, { riskPolicy: policy });
          break;
        }
        case 'courier': {
          const courier = z.enum(COURIER_IDS).parse(field(form, 'courier'));
          const credentials = Object.fromEntries(
            Object.keys(form)
              .filter((k) => !['_csrf', 'op', 'courier'].includes(k))
              .map((k) => [k, field(form, k)]),
          );
          service.connectCourier(seller, courier, credentials);
          break;
        }
        case 'block':
          service.blockPhone(seller, field(form, 'phone'), field(form, 'reason') || null);
          break;
        case 'unblock':
          service.unblockHash(seller, field(form, 'hash'));
          break;
        default:
          return renderSettings(c, { error: 'অজানা অ্যাকশন।', status: 422 });
      }
      return c.redirect(`/app/settings?msg=${op}`, 303);
    } catch (err) {
      const message = errorMessage(err);
      if (message) return renderSettings(c, { error: message, status: 422 });
      throw err;
    }
  });

  // ------------------------------------------------------------------- billing

  const PAID_PLANS = ['starter', 'growth', 'scale'] as const;

  const renderBilling = (c: Context<DashEnv>, cycle: Cycle, extra: { message?: string; error?: string; status?: 200 | 422 } = {}) => {
    const seller = c.get('seller');
    return c.html(
      billingPage({
        seller,
        csrf: c.get('csrf'), now: now(),
        state: billing.state(seller),
        effectivePlan: service.planFor(seller),
        cycle,
        quotes: PAID_PLANS.map((p) => billing.quote(seller, p, cycle)),
        invoices: billing.listInvoices(seller),
        ...extra,
      }),
      extra.status ?? 200,
    );
  };

  app.get('/billing', (c) => {
    const cycle = c.req.query('cycle') === 'annual' ? 'annual' : 'monthly';
    return renderBilling(c, cycle);
  });

  app.post('/billing', async (c) => {
    const seller = c.get('seller');
    const form = await c.req.parseBody();
    const parsed = z
      .object({ plan: z.enum(PAID_PLANS), cycle: z.enum(CYCLES) })
      .safeParse({ plan: field(form, 'plan'), cycle: field(form, 'cycle') });
    if (!parsed.success) return renderBilling(c, 'monthly', { error: 'প্ল্যান বেছে নিন।', status: 422 });
    const invoice = billing.createInvoice(seller, parsed.data.plan, parsed.data.cycle);
    return c.redirect(`/app/billing/invoices/${invoice.id}?msg=created`, 303);
  });

  const renderInvoice = (
    c: Context<DashEnv>,
    invoiceId: string,
    extra: { message?: string; error?: string; form?: Record<string, string>; status?: 200 | 422 } = {},
  ) => {
    const seller = c.get('seller');
    const invoice = billing.getInvoice(seller, invoiceId);
    return c.html(
      invoicePage({
        seller,
        csrf: c.get('csrf'), now: now(),
        invoice,
        payments: billing.invoicePayments(invoice),
        payable: billing.isPayable(invoice),
        paidUntilIfPaidNow: nextPaidUntil(seller, invoice.plan, invoice.cycle, now()),
        options: billing.paymentOptions(),
        ...extra,
      }),
      extra.status ?? 200,
    );
  };

  app.get('/billing/invoices/:id', (c) => {
    const msg = c.req.query('msg');
    try {
      return renderInvoice(c, c.req.param('id'), { message: msg ? BILLING_MESSAGES[msg] : undefined });
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return c.text('Invoice not found', 404);
      throw err;
    }
  });

  app.post('/billing/invoices/:id', async (c) => {
    const seller = c.get('seller');
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const op = field(form, 'op');
    const manual = { method: field(form, 'method'), payerPhone: field(form, 'payerPhone'), reference: field(form, 'reference') };
    try {
      switch (op) {
        case 'online':
          return c.redirect(await billing.startOnlinePayment(seller, id), 303);
        case 'manual':
          billing.submitManualPayment(seller, id, manual);
          return c.redirect(`/app/billing/invoices/${id}?msg=submitted`, 303);
        case 'credit':
          await billing.payWithCredit(seller, id);
          return c.redirect(`/app/billing/invoices/${id}?msg=paid`, 303);
        default:
          return renderInvoice(c, id, { error: 'অজানা অ্যাকশন।', status: 422 });
      }
    } catch (err) {
      if (err instanceof AppError && err.status === 404) return c.text('Invoice not found', 404);
      const message = errorMessage(err);
      if (message) return renderInvoice(c, id, { error: message, form: op === 'manual' ? manual : undefined, status: 422 });
      throw err;
    }
  });

  return app;
}
