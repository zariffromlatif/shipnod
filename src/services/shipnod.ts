import { billingPeriod, OVERAGE_BDT_PER_ORDER, planOf, type Plan, type PlanId } from '../billing/plans.js';
import { subscriptionState } from '../billing/subscription.js';
import { advancePaymentSms, confirmationSms, type SmsLanguage } from '../confirmation/messages.js';
import type { SmsProvider } from '../confirmation/sms.js';
import { courierCredentialSchemas, createCourierAdapter } from '../couriers/registry.js';
import { CourierApiError, type CourierAdapter, type NormalizedDeliveryStatus, type ShipmentRequest } from '../couriers/types.js';
import type { OrderListOptions, Seller, SellerPatch, Store, StoredOrder } from '../db/store.js';
import { assertTransition } from '../domain/order-state.js';
import { maskPhone, normalizeBdPhone } from '../domain/phone.js';
import type { CourierId, DeliveryOutcome, OrderInput, OrderStatus, RiskAssessment } from '../domain/types.js';
import { hashPhone, newId, randomCode, sha256Hex, type SecretBox } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { assessRisk, DEFAULT_RISK_POLICY, type RiskPolicy } from '../risk/score.js';

export interface ServiceDeps {
  store: Store;
  sms: SmsProvider;
  secretBox: SecretBox;
  networkHashSecret: string;
  publicBaseUrl: string;
  confirmTtlHours: number;
  courierSandbox: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface NewSellerInput {
  name: string;
  shopName: string;
  phone?: string;
  plan?: PlanId;
  smsLang?: SmsLanguage;
}

export interface BookingOptions {
  courier?: CourierId;
  area?: ShipmentRequest['area'];
  weightKg?: number;
}

export type SellerAction = 'confirm' | 'cancel' | 'hold' | 'advance_received';

const CONFIRMABLE: readonly OrderStatus[] = ['new', 'awaiting_confirmation', 'awaiting_advance', 'on_hold'];

/**
 * The order pipeline:  ingest → score → act (ship / confirm / advance / hold) → book → outcome → network.
 * Every state change is written to order_events so sellers (and disputes) can see exactly what happened.
 */
export class ShipnodService {
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(private readonly deps: ServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- sellers

  createSeller(input: NewSellerInput): { seller: Seller; apiKey: string } {
    const apiKey = `nsk_${randomCode(40)}`;
    const phone = input.phone ? normalizeBdPhone(input.phone) : null;
    const seller = this.store.createSeller({
      id: newId('sel'),
      name: input.name,
      shopName: input.shopName,
      phone,
      apiKeyHash: sha256Hex(apiKey),
      plan: input.plan ?? 'free',
      smsLang: input.smsLang ?? 'bn',
      advanceFeeBdt: 130,
      bkashNumber: null,
      riskPolicy: null,
      autoBookCourier: null,
      webhookSecret: randomCode(40),
      costPerFailedOrderBdt: 150,
    });
    return { seller, apiKey };
  }

  authenticate(apiKey: string): Seller | null {
    if (!apiKey.startsWith('nsk_')) return null;
    return this.store.getSellerByApiKeyHash(sha256Hex(apiKey));
  }

  findSeller(id: string): Seller | null {
    return this.store.getSeller(id);
  }

  updateSettings(seller: Seller, patch: SellerPatch): Seller {
    if (patch.riskPolicy && !this.planFor(seller).customRiskRules) {
      throw new AppError(402, 'plan_required', 'Custom risk rules need the Growth plan or above');
    }
    if (patch.bkashNumber) {
      const normalized = normalizeBdPhone(patch.bkashNumber);
      if (!normalized) throw new AppError(400, 'invalid_phone', 'bKash number must be a valid Bangladeshi mobile number');
      patch = { ...patch, bkashNumber: normalized };
    }
    return this.store.updateSeller(seller.id, patch);
  }

  /** Subscription status (active, grace, expired…) of a seller right now. */
  subscription(seller: Seller) {
    return subscriptionState(seller, this.now());
  }

  /** The plan whose limits apply right now: an expired paid plan behaves like Free. */
  planFor(seller: Seller): Plan {
    return planOf(this.subscription(seller).effectivePlan);
  }

  policyFor(seller: Seller): RiskPolicy {
    return this.planFor(seller).customRiskRules && seller.riskPolicy ? seller.riskPolicy : DEFAULT_RISK_POLICY;
  }

  // ------------------------------------------------------------------- risk

  private assess(
    seller: Seller,
    args: { phone: string; codAmount: number; address?: string; placedAt?: Date; excludeOrderId?: string },
  ): { normalized: string | null; phoneHash: string | null; risk: RiskAssessment } {
    const normalized = normalizeBdPhone(args.phone);
    const phoneHash = normalized ? hashPhone(this.deps.networkHashSecret, normalized) : null;
    const empty = { delivered: 0, returned: 0, cancelled: 0 };
    const since = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
    const risk = assessRisk(
      {
        phoneValid: normalized !== null,
        codAmount: args.codAmount,
        address: args.address,
        placedAt: args.placedAt ?? this.now(),
        network: phoneHash ? this.store.networkHistory(phoneHash) : empty,
        seller: phoneHash ? this.store.sellerHistory(phoneHash, seller.id) : empty,
        networkReturnSellers: phoneHash ? this.store.returnSellerCount(phoneHash) : 0,
        recentOrders24h: phoneHash ? this.store.recentOrderCount(phoneHash, since, args.excludeOrderId) : 0,
        sellerAverageOrderValue: this.store.sellerAverageOrderValue(seller.id),
        blockedBySeller: phoneHash ? this.store.isBlocked(seller.id, phoneHash) : false,
      },
      this.policyFor(seller),
    );
    return { normalized, phoneHash, risk };
  }

  /** Manual "is this customer safe?" lookup. Metered against the plan's monthly risk checks. */
  checkCustomer(seller: Seller, args: { phone: string; codAmount?: number; address?: string }) {
    const plan = this.planFor(seller);
    const period = billingPeriod(this.now());
    if (this.store.getUsage(seller.id, period).riskChecks >= plan.monthlyRiskChecks) {
      throw new AppError(402, 'quota_exceeded', `Monthly risk-check limit (${plan.monthlyRiskChecks}) reached on the ${plan.name} plan`);
    }
    const { normalized, risk } = this.assess(seller, { phone: args.phone, codAmount: args.codAmount ?? 1000, address: args.address });
    this.store.incrementUsage(seller.id, period, { riskChecks: 1 });
    return { phone: normalized, valid: normalized !== null, risk };
  }

  // ----------------------------------------------------------------- orders

  /** Idempotent on (source, externalId), so webhook retries never create duplicates. */
  async createOrder(seller: Seller, input: OrderInput): Promise<{ order: StoredOrder; created: boolean }> {
    const plan = this.planFor(seller);
    if (plan.monthlyOrders === 0) {
      throw new AppError(402, 'plan_required', 'Order automation needs a paid plan (Starter or above)');
    }
    if (input.externalId) {
      const existing = this.store.findOrderByExternalId(seller.id, input.source, input.externalId);
      if (existing) return { order: existing, created: false };
    }

    const id = newId('ord');
    const placedAt = input.placedAt ?? this.now();
    const { normalized, phoneHash, risk } = this.assess(seller, {
      phone: input.phone,
      codAmount: input.codAmount,
      address: input.address,
      placedAt,
      excludeOrderId: id,
    });
    const ts = this.now().toISOString();
    let order = this.store.insertOrder({
      id,
      sellerId: seller.id,
      externalId: input.externalId ?? null,
      source: input.source,
      customerName: input.customerName.trim() || 'Customer',
      phone: normalized ?? input.phone,
      phoneValid: normalized !== null,
      phoneHash,
      address: input.address.trim(),
      district: input.district ?? null,
      codAmount: input.codAmount,
      items: input.items,
      note: input.note ?? null,
      status: 'new',
      risk,
      confirmCode: null,
      confirmExpiresAt: null,
      courier: null,
      consignmentId: null,
      trackingCode: null,
      createdAt: ts,
      updatedAt: ts,
    });
    this.store.addOrderEvent({ orderId: id, from: null, to: 'new', actor: `import:${input.source}`, detail: `risk ${risk.score} (${risk.level})` });
    // Orders beyond the quota are recorded now, against the plan active now, and billed on the next invoice.
    const period = billingPeriod(this.now());
    const overage = this.store.getUsage(seller.id, period).orders >= plan.monthlyOrders ? 1 : 0;
    this.store.incrementUsage(seller.id, period, { orders: 1, overageOrders: overage });

    // An unreachable number can't confirm anything — always hold regardless of custom thresholds.
    const action = order.phoneValid ? risk.action : 'hold';
    switch (action) {
      case 'auto_ship':
        order = this.transition(order, 'confirmed', 'risk_engine', 'low risk: auto-approved');
        order = await this.maybeAutoBook(seller, order);
        break;
      case 'confirm':
        order = await this.requestCustomerResponse(seller, order, 'awaiting_confirmation');
        break;
      case 'advance_payment':
        order = await this.requestCustomerResponse(seller, order, 'awaiting_advance');
        break;
      case 'hold':
        order = this.transition(order, 'on_hold', 'risk_engine', order.phoneValid ? 'critical risk' : 'invalid phone number');
        break;
    }
    return { order, created: true };
  }

  getOrder(seller: Seller, orderId: string) {
    const order = this.store.getSellerOrder(seller.id, orderId);
    if (!order) throw notFound('Order');
    return { order, events: this.store.listOrderEvents(order.id) };
  }

  listOrders(seller: Seller, opts: OrderListOptions) {
    const search = opts.search?.trim();
    // A phone typed in any format (+880…, Bangla digits) should still find the stored "01…" number.
    const normalized = search ? normalizeBdPhone(search) : null;
    return this.store.listOrders(seller.id, { ...opts, search: normalized ?? (search || undefined) });
  }

  /** All-time order counts per status, for dashboard tabs and to-do counters. */
  orderCounts(seller: Seller): Partial<Record<OrderStatus, number>> {
    return this.store.countOrdersByStatus(seller.id) as Partial<Record<OrderStatus, number>>;
  }

  private transition(order: StoredOrder, to: OrderStatus, actor: string, detail?: string): StoredOrder {
    assertTransition(order.status, to);
    const updated = this.store.updateOrder(order.id, { status: to });
    this.store.addOrderEvent({ orderId: order.id, from: order.status, to, actor, detail });
    return updated;
  }

  private async requestCustomerResponse(
    seller: Seller,
    order: StoredOrder,
    status: 'awaiting_confirmation' | 'awaiting_advance',
  ): Promise<StoredOrder> {
    const code = randomCode(8);
    const expires = new Date(this.now().getTime() + this.deps.confirmTtlHours * 3600_000).toISOString();
    this.store.updateOrder(order.id, { confirmCode: code, confirmExpiresAt: expires });
    const updated = order.status === status ? this.store.getOrder(order.id)! : this.transition(order, status, 'risk_engine');
    await this.sendCustomerSms(seller, updated, status === 'awaiting_advance' ? 'advance' : 'confirm');
    return this.store.getOrder(order.id)!;
  }

  private async sendCustomerSms(seller: Seller, order: StoredOrder, kind: 'confirm' | 'advance'): Promise<void> {
    if (!order.confirmCode) return;
    const link = `${this.deps.publicBaseUrl}/c/${order.confirmCode}`;
    const msg =
      kind === 'confirm'
        ? confirmationSms({ shopName: seller.shopName, amount: order.codAmount, link, lang: seller.smsLang })
        : advancePaymentSms({ shopName: seller.shopName, fee: seller.advanceFeeBdt, link, lang: seller.smsLang });
    const result = await this.deps.sms.send({ to: order.phone, text: msg.text });
    this.store.logSms({
      sellerId: seller.id,
      orderId: order.id,
      to: order.phone,
      text: msg.text,
      segments: msg.segments,
      ok: result.ok,
      providerMessageId: result.providerMessageId,
      error: result.error,
    });
    if (result.ok) {
      this.store.incrementUsage(seller.id, billingPeriod(this.now()), { smsSent: 1, smsSegments: msg.segments });
    } else {
      this.store.addOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'sms', detail: `SMS failed: ${result.error ?? 'unknown'}` });
    }
  }

  /** Issue a fresh link and resend the SMS (e.g. customer says they never got it). */
  async resendConfirmation(seller: Seller, orderId: string): Promise<StoredOrder> {
    const { order } = this.getOrder(seller, orderId);
    if (order.status !== 'awaiting_confirmation' && order.status !== 'awaiting_advance') {
      throw new AppError(409, 'invalid_state', `Order is ${order.status}; nothing to resend`);
    }
    return this.requestCustomerResponse(seller, order, order.status);
  }

  // -------------------------------------------------------- customer link

  getConfirmation(code: string): { order: StoredOrder; seller: Seller; expired: boolean } | null {
    const order = this.store.getOrderByConfirmCode(code);
    if (!order) return null;
    const seller = this.store.getSeller(order.sellerId)!;
    const expired = order.confirmExpiresAt !== null && new Date(order.confirmExpiresAt) < this.now();
    return { order, seller, expired };
  }

  async customerRespond(code: string, decision: 'confirm' | 'cancel'): Promise<StoredOrder> {
    const found = this.getConfirmation(code);
    if (!found) throw notFound('Confirmation link');
    const { order, seller, expired } = found;
    const pending = order.status === 'awaiting_confirmation' || order.status === 'awaiting_advance';
    if (!pending) return order; // already answered; idempotent
    if (expired) throw new AppError(410, 'expired', 'This confirmation link has expired');

    if (decision === 'cancel') {
      const updated = this.transition(order, 'cancelled', 'customer', 'cancelled via confirmation link');
      this.recordNetworkOutcome(updated, 'cancelled');
      return updated;
    }
    if (order.status === 'awaiting_advance') {
      throw new AppError(409, 'advance_required', 'The seller confirms this order once the advance payment is received');
    }
    const confirmed = this.transition(order, 'confirmed', 'customer', 'confirmed via link');
    return this.maybeAutoBook(seller, confirmed);
  }

  // --------------------------------------------------------- seller actions

  async sellerAction(seller: Seller, orderId: string, action: SellerAction, opts: { customerRefused?: boolean } = {}) {
    const { order } = this.getOrder(seller, orderId);
    switch (action) {
      case 'confirm': {
        if (!CONFIRMABLE.includes(order.status)) throw new AppError(409, 'invalid_state', `Order is ${order.status}`);
        const confirmed = this.transition(order, 'confirmed', 'seller');
        return this.maybeAutoBook(seller, confirmed);
      }
      case 'advance_received': {
        if (order.status !== 'awaiting_advance') throw new AppError(409, 'invalid_state', `Order is ${order.status}`);
        const confirmed = this.transition(order, 'confirmed', 'seller', 'advance payment received');
        return this.maybeAutoBook(seller, confirmed);
      }
      case 'hold':
        return this.transition(order, 'on_hold', 'seller');
      case 'cancel': {
        const cancelled = this.transition(order, 'cancelled', 'seller', opts.customerRefused ? 'customer refused' : undefined);
        if (opts.customerRefused) this.recordNetworkOutcome(cancelled, 'cancelled');
        return cancelled;
      }
    }
  }

  // --------------------------------------------------------------- couriers

  connectCourier(seller: Seller, courier: CourierId, credentials: unknown): CourierId[] {
    const plan = this.planFor(seller);
    const connected = this.store.listCourierAccounts(seller.id);
    if (!connected.includes(courier) && connected.length >= plan.maxCouriers) {
      throw new AppError(402, 'plan_limit', `The ${plan.name} plan allows ${plan.maxCouriers} courier account(s)`);
    }
    const parsed = courierCredentialSchemas[courier].parse(credentials);
    this.store.saveCourierAccount(seller.id, courier, this.deps.secretBox.seal(JSON.stringify(parsed)));
    return this.store.listCourierAccounts(seller.id);
  }

  listCouriers(seller: Seller): CourierId[] {
    return this.store.listCourierAccounts(seller.id);
  }

  private adapterFor(sellerId: string, courier: CourierId): CourierAdapter {
    const sealed = this.store.getCourierAccount(sellerId, courier);
    if (!sealed) throw new AppError(422, 'courier_not_connected', `Connect your ${courier} account first`);
    const creds: unknown = JSON.parse(this.deps.secretBox.open(sealed));
    return createCourierAdapter(courier, creds, { sandbox: this.deps.courierSandbox, fetch: this.deps.fetch });
  }

  async bookCourier(seller: Seller, orderId: string, opts: BookingOptions = {}): Promise<StoredOrder> {
    const { order } = this.getOrder(seller, orderId);
    if (order.status !== 'confirmed') throw new AppError(409, 'invalid_state', `Only confirmed orders can be booked (order is ${order.status})`);
    const courier = opts.courier ?? seller.autoBookCourier;
    if (!courier) throw new AppError(422, 'courier_required', 'Pick a courier or set a default auto-book courier');
    const adapter = this.adapterFor(seller.id, courier);
    const shipment: ShipmentRequest = {
      invoice: order.id,
      recipientName: order.customerName,
      recipientPhone: order.phone,
      recipientAddress: order.address,
      codAmount: order.codAmount,
      itemDescription: order.items.map((i) => `${i.name} x${i.quantity}`).join(', ').slice(0, 250),
      itemQuantity: order.items.reduce((n, i) => n + i.quantity, 0) || 1,
      weightKg: opts.weightKg,
      note: order.note ?? undefined,
      area: opts.area,
    };
    try {
      const booking = await adapter.createParcel(shipment);
      this.store.updateOrder(order.id, {
        courier,
        consignmentId: booking.consignmentId,
        trackingCode: booking.trackingCode,
      });
      return this.transition(this.store.getOrder(order.id)!, 'booked', 'seller', `${courier} #${booking.consignmentId}`);
    } catch (err) {
      if (err instanceof CourierApiError) throw new AppError(502, 'courier_error', err.message);
      throw err;
    }
  }

  /** Books automatically when the seller has a default courier; failures leave the order confirmed. */
  private async maybeAutoBook(seller: Seller, order: StoredOrder): Promise<StoredOrder> {
    if (!seller.autoBookCourier || order.status !== 'confirmed') return order;
    if (!this.store.getCourierAccount(seller.id, seller.autoBookCourier)) return order;
    if (seller.autoBookCourier !== 'steadfast') return order; // Pathao/RedX need per-order area ids
    try {
      return await this.bookCourier(seller, order.id, { courier: seller.autoBookCourier });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.store.addOrderEvent({ orderId: order.id, from: order.status, to: order.status, actor: 'auto_book', detail: `failed: ${detail}` });
      return this.store.getOrder(order.id)!;
    }
  }

  // ------------------------------------------------------------- outcomes

  private recordNetworkOutcome(order: StoredOrder, outcome: DeliveryOutcome): void {
    if (order.phoneHash) {
      this.store.recordOutcome({ orderId: order.id, phoneHash: order.phoneHash, sellerId: order.sellerId, outcome });
    }
  }

  /** Manual outcome entry, for sellers who ship outside Shipnod (most F-commerce pages at first). */
  recordOutcome(seller: Seller, orderId: string, outcome: 'delivered' | 'returned'): StoredOrder {
    const { order } = this.getOrder(seller, orderId);
    const updated = this.transition(order, outcome, 'seller');
    this.recordNetworkOutcome(updated, outcome);
    return updated;
  }

  private applyCourierStatus(order: StoredOrder, status: NormalizedDeliveryStatus, raw: string): boolean {
    const actor = `courier:${order.courier}`;
    switch (status) {
      case 'in_transit':
        if (order.status !== 'booked') return false;
        this.transition(order, 'in_transit', actor, raw);
        return true;
      case 'delivered':
      case 'returned': {
        const updated = this.transition(order, status, actor, raw);
        this.recordNetworkOutcome(updated, status);
        return true;
      }
      case 'cancelled':
        if (order.status !== 'booked') return false;
        this.transition(order, 'cancelled', actor, raw);
        return true;
      default:
        return false;
    }
  }

  /** Polls couriers for every parcel still out; run on a timer by the server. */
  async syncShippedOrders(limit = 200): Promise<{ checked: number; updated: number; errors: number }> {
    const adapters = new Map<string, CourierAdapter>();
    let checked = 0;
    let updated = 0;
    let errors = 0;
    for (const order of this.store.listShippedOrders(limit)) {
      checked++;
      try {
        const key = `${order.sellerId}:${order.courier}`;
        let adapter = adapters.get(key);
        if (!adapter) {
          adapter = this.adapterFor(order.sellerId, order.courier!);
          adapters.set(key, adapter);
        }
        const { status, rawStatus } = await adapter.getStatus(order.consignmentId!, order.trackingCode);
        if (this.applyCourierStatus(order, status, rawStatus)) updated++;
      } catch (err) {
        errors++;
        console.error(`[sync] order ${order.id}:`, err instanceof Error ? err.message : err);
      }
    }
    return { checked, updated, errors };
  }

  // ------------------------------------------------------------ blocklist

  blockPhone(seller: Seller, phone: string, reason: string | null): void {
    const normalized = normalizeBdPhone(phone);
    if (!normalized) throw new AppError(400, 'invalid_phone', 'Not a valid Bangladeshi mobile number');
    this.store.block(seller.id, hashPhone(this.deps.networkHashSecret, normalized), reason, maskPhone(normalized));
  }

  listBlocklist(seller: Seller) {
    return this.store.listBlocklist(seller.id);
  }

  /** Dashboard unblock: entries are identified by hash because the raw number is never stored. */
  unblockHash(seller: Seller, phoneHash: string): boolean {
    return this.store.unblock(seller.id, phoneHash);
  }

  unblockPhone(seller: Seller, phone: string): boolean {
    const normalized = normalizeBdPhone(phone);
    if (!normalized) throw new AppError(400, 'invalid_phone', 'Not a valid Bangladeshi mobile number');
    return this.store.unblock(seller.id, hashPhone(this.deps.networkHashSecret, normalized));
  }

  // ----------------------------------------------------------- reporting

  stats(seller: Seller, days = 30) {
    const since = new Date(this.now().getTime() - days * 86400_000).toISOString();
    const byStatus = this.store.countOrdersByStatus(seller.id, since);
    const n = (s: OrderStatus) => byStatus[s] ?? 0;
    const delivered = n('delivered');
    const returned = n('returned');
    const cancelled = n('cancelled');
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return {
      days,
      totalOrders: total,
      byStatus,
      rtoRate: delivered + returned > 0 ? returned / (delivered + returned) : null,
      /** Orders stopped before a parcel left the warehouse. */
      stoppedBeforeShipping: cancelled,
      /** Estimate: each stopped order is one failed delivery the seller didn't pay for. */
      estimatedSavedBdt: cancelled * seller.costPerFailedOrderBdt,
      costPerFailedOrderBdt: seller.costPerFailedOrderBdt,
    };
  }

  usage(seller: Seller) {
    const plan: Plan = this.planFor(seller);
    const period = billingPeriod(this.now());
    const usage = this.store.getUsage(seller.id, period);
    return { period, plan, usage, overageBdt: usage.overageOrders * OVERAGE_BDT_PER_ORDER, subscription: this.subscription(seller) };
  }
}
