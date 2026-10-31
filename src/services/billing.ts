import { billingPeriod, OVERAGE_BDT_PER_ORDER, planOf, type PlanId } from '../billing/plans.js';
import type { SslCommerzClient } from '../billing/sslcommerz.js';
import {
  cyclePriceBdt,
  dailyRate,
  monthlyRecurringBdt,
  nextPaidUntil,
  prorationCreditBdt,
  subscriptionState,
  type Cycle,
} from '../billing/subscription.js';
import type { SmsProvider } from '../confirmation/sms.js';
import {
  DuplicateReferenceError,
  type BillingRepo,
  type Invoice,
  type InvoiceLine,
  type Payment,
  type PaymentMethod,
} from '../db/billing-repo.js';
import type { Seller, Store } from '../db/store.js';
import { normalizeBdPhone } from '../domain/phone.js';
import { newId } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';

export const INVOICE_TTL_HOURS = 24;
/** bKash TrxIDs are 10 characters, Nagad's 8; accept a little slack for other formats. */
const TRX_ID = /^[A-Z0-9]{8,12}$/;
const DAY = 86_400_000;

export interface BillingDeps {
  store: Store;
  repo: BillingRepo;
  sms: SmsProvider;
  publicBaseUrl: string;
  /** null until an SSLCommerz merchant account is configured. */
  sslcommerz: SslCommerzClient | null;
  /** Merchant/personal numbers for manual Send Money; null hides that option. */
  manual: { bkash: string | null; nagad: string | null };
  now?: () => Date;
}

export interface Quote {
  plan: PlanId;
  cycle: Cycle;
  lines: InvoiceLine[];
  subtotalBdt: number;
  prorationCreditBdt: number;
  balanceCreditBdt: number;
  creditAppliedBdt: number;
  totalBdt: number;
  /** Seller's credit balance after paying this invoice. */
  creditAfterBdt: number;
  /** When the plan would run until if paid now. */
  paidUntil: Date;
}

export type ReturnOutcome = 'paid' | 'review' | 'failed' | 'cancelled' | 'unknown';

const SMS_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' });
const smsDate = (d: Date) => SMS_DATE.format(d);

/**
 * Prepaid plan purchases. Flow: quote → invoice (24h, one open per seller) → payment
 * (SSLCommerz, manual bKash/Nagad reviewed by an admin, or account credit) → plan activated.
 */
export class BillingService {
  private readonly store: Store;
  private readonly repo: BillingRepo;
  private readonly now: () => Date;

  constructor(private readonly deps: BillingDeps) {
    this.store = deps.store;
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
  }

  paymentOptions() {
    return { online: this.deps.sslcommerz !== null, bkash: this.deps.manual.bkash, nagad: this.deps.manual.nagad };
  }

  state(seller: Seller) {
    return subscriptionState(seller, this.now());
  }

  // ------------------------------------------------------------------ invoices

  quote(seller: Seller, plan: PlanId, cycle: Cycle): Quote {
    if (plan === 'free') throw new AppError(400, 'invalid_plan', 'The Free plan needs no payment');
    const now = this.now();
    const lines: InvoiceLine[] = [
      {
        kind: 'plan',
        description: `${planOf(plan).name} plan · ${cycle === 'annual' ? '12 months (365 days)' : '1 month (30 days)'}`,
        amountBdt: cyclePriceBdt(plan, cycle),
      },
    ];
    for (const o of this.repo.unbilledOverage(seller.id, billingPeriod(now))) {
      lines.push({
        kind: 'overage',
        description: `Extra orders in ${o.period}: ${o.orders} × Tk ${OVERAGE_BDT_PER_ORDER}`,
        amountBdt: Math.round(o.orders * OVERAGE_BDT_PER_ORDER),
        period: o.period,
        orders: o.orders,
      });
    }
    const subtotal = lines.reduce((n, l) => n + l.amountBdt, 0);
    const proration = prorationCreditBdt(seller, plan, now);
    const balance = Math.max(0, seller.creditBdt);
    const applied = Math.min(proration + balance, subtotal);
    return {
      plan,
      cycle,
      lines,
      subtotalBdt: subtotal,
      prorationCreditBdt: proration,
      balanceCreditBdt: balance,
      creditAppliedBdt: applied,
      totalBdt: subtotal - applied,
      creditAfterBdt: proration + balance - applied,
      paidUntil: nextPaidUntil(seller, plan, cycle, now),
    };
  }

  createInvoice(seller: Seller, plan: PlanId, cycle: Cycle): Invoice {
    const q = this.quote(seller, plan, cycle);
    const now = this.now();
    return this.store.transaction(() => {
      this.repo.voidOpenInvoices(seller.id);
      return this.repo.insertInvoice({
        id: newId('inv'),
        number: this.repo.nextInvoiceNumber(Number(billingPeriod(now).slice(0, 4))),
        sellerId: seller.id,
        status: 'open',
        plan,
        cycle,
        lines: q.lines,
        subtotalBdt: q.subtotalBdt,
        prorationCreditBdt: q.prorationCreditBdt,
        balanceCreditBdt: q.balanceCreditBdt,
        creditAppliedBdt: q.creditAppliedBdt,
        totalBdt: q.totalBdt,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + INVOICE_TTL_HOURS * 3600_000).toISOString(),
        paidAt: null,
        paymentMethod: null,
      });
    });
  }

  getInvoice(seller: Seller, invoiceId: string): Invoice {
    const invoice = this.repo.getInvoice(invoiceId);
    if (!invoice || invoice.sellerId !== seller.id) throw notFound('Invoice');
    return invoice;
  }

  listInvoices(seller: Seller): Invoice[] {
    return this.repo.listInvoices(seller.id);
  }

  invoicePayments(invoice: Invoice): Payment[] {
    return this.repo.listInvoicePayments(invoice.id);
  }

  isPayable(invoice: Invoice): boolean {
    return invoice.status === 'open' && new Date(invoice.expiresAt) > this.now();
  }

  private payableInvoice(seller: Seller, invoiceId: string): Invoice {
    const invoice = this.getInvoice(seller, invoiceId);
    if (invoice.status === 'paid') throw new AppError(409, 'already_paid', 'This invoice is already paid');
    if (!this.isPayable(invoice)) throw new AppError(410, 'invoice_expired', 'This invoice has expired; create a new one');
    return invoice;
  }

  // ---------------------------------------------------------- online (SSLCommerz)

  /** Creates a payment and returns the SSLCommerz page to send the seller to. */
  async startOnlinePayment(seller: Seller, invoiceId: string): Promise<string> {
    const gateway = this.deps.sslcommerz;
    if (!gateway) throw new AppError(422, 'online_unavailable', 'Online payment is not set up yet');
    const invoice = this.payableInvoice(seller, invoiceId);
    if (invoice.totalBdt <= 0) throw new AppError(409, 'nothing_to_pay', 'This invoice is fully covered by credit');

    const now = this.now().toISOString();
    const payment = this.repo.insertPayment({
      id: newId('pay'),
      invoiceId: invoice.id,
      sellerId: seller.id,
      method: 'sslcommerz',
      status: 'initiated',
      amountBdt: invoice.totalBdt,
      reference: null,
      payerPhone: seller.phone,
      detail: null,
      createdAt: now,
      updatedAt: now,
    });
    const base = this.deps.publicBaseUrl;
    try {
      const session = await gateway.initSession({
        tranId: payment.id,
        amountBdt: invoice.totalBdt,
        productName: `Shipnod ${planOf(invoice.plan).name} (${invoice.cycle}) ${invoice.number}`,
        customer: {
          name: seller.name || seller.shopName,
          phone: seller.phone ?? '01000000000',
          email: `billing@${new URL(base).hostname}`,
        },
        urls: {
          success: `${base}/billing/sslcommerz/success`,
          fail: `${base}/billing/sslcommerz/fail`,
          cancel: `${base}/billing/sslcommerz/cancel`,
          ipn: `${base}/billing/sslcommerz/ipn`,
        },
      });
      return session.gatewayUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.updatePayment(payment.id, { status: 'failed', detail: message }, this.now().toISOString());
      throw new AppError(502, 'payment_provider_error', message);
    }
  }

  /**
   * Handles SSLCommerz's browser returns and IPN. Safe to call repeatedly and concurrently for the same
   * transaction: the result is decided by SSLCommerz's validation API, and applying it is synchronous.
   */
  async handleSslcommerz(
    fields: Record<string, string>,
    source: 'success' | 'fail' | 'cancel' | 'ipn',
  ): Promise<{ invoiceId: string | null; outcome: ReturnOutcome }> {
    const payment = fields.tran_id ? this.repo.getPayment(fields.tran_id) : null;
    if (!payment || payment.method !== 'sslcommerz') return { invoiceId: null, outcome: 'unknown' };
    const done = this.settledOutcome(payment);
    if (done) return { invoiceId: payment.invoiceId, outcome: done };

    const gateway = this.deps.sslcommerz;
    const valId = fields.val_id;
    if (!valId || !gateway) {
      if (source === 'fail' || source === 'cancel') {
        if (payment.status === 'initiated') {
          this.repo.updatePayment(payment.id, { status: 'failed', detail: source === 'cancel' ? 'cancelled by payer' : 'failed at gateway' }, this.now().toISOString());
        }
        return { invoiceId: payment.invoiceId, outcome: source === 'cancel' ? 'cancelled' : 'failed' };
      }
      return { invoiceId: payment.invoiceId, outcome: 'unknown' };
    }

    let result;
    try {
      result = await gateway.validate(valId);
    } catch (err) {
      console.error('[billing] SSLCommerz validation error:', err instanceof Error ? err.message : err);
      return { invoiceId: payment.invoiceId, outcome: 'unknown' };
    }

    // Everything below is synchronous: a concurrent IPN/redirect for the same payment can't interleave.
    const current = this.repo.getPayment(payment.id)!;
    const settled = this.settledOutcome(current);
    if (settled) return { invoiceId: current.invoiceId, outcome: settled };

    const nowIso = this.now().toISOString();
    const paid =
      ['VALID', 'VALIDATED'].includes(result.status) &&
      result.tranId === current.id &&
      Math.abs(result.amount - current.amountBdt) < 0.01 &&
      result.currency === 'BDT';
    if (!paid) {
      this.repo.updatePayment(
        current.id,
        { status: 'failed', detail: `validation: ${result.status || 'unknown'} (${result.currency} ${result.amount})`, raw: result.raw },
        nowIso,
      );
      return { invoiceId: current.invoiceId, outcome: 'failed' };
    }
    if (result.riskLevel === '1') {
      this.repo.updatePayment(
        current.id,
        { status: 'pending_review', reference: result.bankTranId, detail: 'SSLCommerz flagged this payment as risky', raw: result.raw },
        nowIso,
      );
      return { invoiceId: current.invoiceId, outcome: 'review' };
    }
    this.repo.updatePayment(current.id, { reference: result.bankTranId, detail: result.cardType, raw: result.raw }, nowIso);
    const applied = this.settle(current);
    await this.notifyPaid(applied);
    return { invoiceId: current.invoiceId, outcome: 'paid' };
  }

  private settledOutcome(p: Payment): ReturnOutcome | null {
    if (p.status === 'succeeded') return 'paid';
    if (p.status === 'pending_review') return 'review';
    if (p.status === 'rejected') return 'failed';
    return null;
  }

  // ------------------------------------------------------- manual bKash / Nagad

  submitManualPayment(seller: Seller, invoiceId: string, input: { method: string; payerPhone: string; reference: string }): Payment {
    const method = input.method === 'nagad' ? 'nagad' : input.method === 'bkash' ? 'bkash' : null;
    if (!method || !this.deps.manual[method]) throw new AppError(400, 'invalid_method', 'This payment method is not available');
    const invoice = this.payableInvoice(seller, invoiceId);
    if (invoice.totalBdt <= 0) throw new AppError(409, 'nothing_to_pay', 'This invoice is fully covered by credit');
    const reference = input.reference.replace(/\s+/g, '').toUpperCase();
    if (!TRX_ID.test(reference)) throw new AppError(400, 'invalid_reference', 'Enter the transaction ID from the bKash/Nagad message');
    const payerPhone = normalizeBdPhone(input.payerPhone);
    if (!payerPhone) throw new AppError(400, 'invalid_phone', 'Enter the number you paid from');
    if (this.repo.listInvoicePayments(invoice.id).some((p) => p.status === 'pending_review')) {
      throw new AppError(409, 'already_submitted', 'A payment for this invoice is already waiting for review');
    }
    const now = this.now().toISOString();
    try {
      return this.repo.insertPayment({
        id: newId('pay'),
        invoiceId: invoice.id,
        sellerId: seller.id,
        method,
        status: 'pending_review',
        amountBdt: invoice.totalBdt,
        reference,
        payerPhone,
        detail: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (err instanceof DuplicateReferenceError) {
        throw new AppError(409, 'duplicate_reference', 'This transaction ID has already been submitted');
      }
      throw err;
    }
  }

  async approvePayment(paymentId: string): Promise<Invoice> {
    const payment = this.repo.getPayment(paymentId);
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'pending_review') throw new AppError(409, 'invalid_state', `Payment is ${payment.status}`);
    const invoice = this.settle(payment);
    await this.notifyPaid(invoice);
    return invoice;
  }

  async rejectPayment(paymentId: string, reason: string): Promise<void> {
    const payment = this.repo.getPayment(paymentId);
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'pending_review') throw new AppError(409, 'invalid_state', `Payment is ${payment.status}`);
    this.repo.updatePayment(payment.id, { status: 'rejected', detail: reason || 'rejected' }, this.now().toISOString());
    const seller = this.store.getSeller(payment.sellerId);
    if (seller?.phone) {
      await this.deps.sms.send({
        to: seller.phone,
        text: `Shipnod: We could not verify your payment${payment.reference ? ` (TrxID ${payment.reference})` : ''}. Please check and try again: ${this.deps.publicBaseUrl}/app/billing`,
      });
    }
  }

  /** Invoices fully covered by credit (e.g. a downgrade) are activated without a payment. */
  async payWithCredit(seller: Seller, invoiceId: string): Promise<Invoice> {
    const invoice = this.payableInvoice(seller, invoiceId);
    if (invoice.totalBdt !== 0) throw new AppError(409, 'payment_required', 'This invoice still has an amount to pay');
    const now = this.now().toISOString();
    const payment = this.repo.insertPayment({
      id: newId('pay'),
      invoiceId: invoice.id,
      sellerId: seller.id,
      method: 'credit',
      status: 'initiated',
      amountBdt: 0,
      reference: null,
      payerPhone: null,
      detail: 'paid from account credit',
      createdAt: now,
      updatedAt: now,
    });
    const paid = this.settle(payment);
    await this.notifyPaid(paid);
    return paid;
  }

  // -------------------------------------------------------------- activation

  /**
   * Marks the payment succeeded and activates the plan, in one transaction. If the invoice was already
   * paid (a second payment for the same invoice), the money becomes account credit instead.
   */
  private settle(payment: Payment): Invoice {
    const now = this.now();
    const nowIso = now.toISOString();
    return this.store.transaction(() => {
      const invoice = this.repo.getInvoice(payment.invoiceId)!;
      const seller = this.store.getSeller(payment.sellerId)!;
      if (invoice.status === 'paid') {
        this.repo.updatePayment(payment.id, { status: 'succeeded', detail: 'invoice was already paid; amount added as account credit' }, nowIso);
        this.store.updateSeller(seller.id, { creditBdt: seller.creditBdt + payment.amountBdt });
        return invoice;
      }
      // A void invoice can still be paid: the seller may finish an SSLCommerz checkout after opening a newer invoice.
      const leftover = invoice.prorationCreditBdt + invoice.balanceCreditBdt - invoice.creditAppliedBdt;
      this.store.updateSeller(seller.id, {
        plan: invoice.plan,
        planCycle: invoice.cycle,
        planPaidUntil: nextPaidUntil(seller, invoice.plan, invoice.cycle, now).toISOString(),
        planDailyRate: dailyRate(invoice.plan, invoice.cycle),
        creditBdt: Math.max(0, seller.creditBdt - invoice.balanceCreditBdt) + leftover,
        billingReminder: null,
      });
      this.repo.updatePayment(payment.id, { status: 'succeeded' }, nowIso);
      this.repo.markInvoicePaid(invoice.id, nowIso, payment.method as PaymentMethod);
      const periods = invoice.lines.filter((l) => l.kind === 'overage' && l.period).map((l) => l.period!);
      this.repo.markOverageBilled(seller.id, periods, invoice.id);
      return this.repo.getInvoice(invoice.id)!;
    });
  }

  private async notifyPaid(invoice: Invoice): Promise<void> {
    const seller = this.store.getSeller(invoice.sellerId);
    if (!seller?.phone || !seller.planPaidUntil) return;
    await this.deps.sms.send({
      to: seller.phone,
      text: `Shipnod: Payment received for ${invoice.number}. ${planOf(seller.plan).name} plan active until ${smsDate(new Date(seller.planPaidUntil))}. Thank you!`,
    });
  }

  // ------------------------------------------------------------------- admin

  /** Comp a plan (pilots, partners). days = null means no expiry. */
  grantPlan(sellerId: string, plan: PlanId, days: number | null): Seller {
    const seller = this.store.getSeller(sellerId);
    if (!seller) throw notFound('Seller');
    return this.store.updateSeller(sellerId, {
      plan,
      planCycle: null,
      planPaidUntil: days === null ? null : new Date(this.now().getTime() + days * DAY).toISOString(),
      planDailyRate: 0,
      billingReminder: null,
    });
  }

  pendingPayments() {
    return this.repo.listPaymentsByStatus('pending_review').map((p) => ({
      payment: p,
      invoice: this.repo.getInvoice(p.invoiceId)!,
      seller: this.store.getSeller(p.sellerId)!,
    }));
  }

  recentInvoices(limit = 30) {
    return this.repo.listRecentInvoices(limit).map((invoice) => ({ invoice, seller: this.store.getSeller(invoice.sellerId)! }));
  }

  sellersOverview() {
    const now = this.now();
    return this.store.listSellers().map((seller) => ({ seller, state: subscriptionState(seller, now), mrrBdt: monthlyRecurringBdt(seller, now) }));
  }

  overview() {
    const now = this.now();
    const sellers = this.sellersOverview();
    const count = (status: string) => sellers.filter((s) => s.state.status === status).length;
    return {
      mrrBdt: sellers.reduce((n, s) => n + s.mrrBdt, 0),
      activePaid: sellers.filter((s) => s.mrrBdt > 0).length,
      grace: count('grace'),
      comped: count('comped'),
      expired: count('expired'),
      revenue30dBdt: this.repo.revenueSince(new Date(now.getTime() - 30 * DAY).toISOString()),
      pendingReviews: this.repo.listPaymentsByStatus('pending_review').length,
    };
  }

  // --------------------------------------------------------------- reminders

  /** Renewal SMS: 5 days and 1 day before expiry, when grace starts, and when the account drops to Free. */
  async runReminders(): Promise<number> {
    const now = this.now();
    const base = this.deps.publicBaseUrl;
    let sent = 0;
    for (const seller of this.store.listSellers()) {
      if (!seller.phone || !seller.planPaidUntil || seller.plan === 'free') continue;
      const st = subscriptionState(seller, now);
      const name = planOf(seller.plan).name;
      let stage: string | null = null;
      let text = '';
      if (st.status === 'active' && st.daysLeft !== null && st.daysLeft <= 1) {
        stage = 'd1';
        text = `Shipnod: Your ${name} plan ends tomorrow (${smsDate(st.paidUntil!)}). Renew to keep orders flowing: ${base}/app/billing`;
      } else if (st.status === 'active' && st.daysLeft !== null && st.daysLeft <= 5) {
        stage = 'd5';
        text = `Shipnod: Your ${name} plan ends on ${smsDate(st.paidUntil!)}. Renew to keep orders flowing: ${base}/app/billing`;
      } else if (st.status === 'grace') {
        stage = 'grace';
        text = `Shipnod: Your ${name} plan has ended. Renew by ${smsDate(st.graceEndsAt!)} to avoid interruption: ${base}/app/billing`;
      } else if (st.status === 'expired' && now.getTime() - st.graceEndsAt!.getTime() < DAY) {
        stage = 'expired';
        text = `Shipnod: Your account is now on the Free plan and orders are no longer automated. Renew: ${base}/app/billing`;
      }
      const key = stage ? `${seller.planPaidUntil}|${stage}` : null;
      if (!key || seller.billingReminder === key) continue;
      const result = await this.deps.sms.send({ to: seller.phone, text });
      if (result.ok) {
        this.store.updateSeller(seller.id, { billingReminder: key });
        sent++;
      }
    }
    return sent;
  }
}
