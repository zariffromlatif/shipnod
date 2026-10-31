import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { PlanId } from '../billing/plans.js';
import type { Cycle } from '../billing/subscription.js';

export type InvoiceStatus = 'open' | 'paid' | 'void';
export type PaymentMethod = 'sslcommerz' | 'bkash' | 'nagad' | 'credit';
export type PaymentStatus = 'initiated' | 'pending_review' | 'succeeded' | 'failed' | 'rejected';

export interface InvoiceLine {
  kind: 'plan' | 'overage';
  description: string;
  amountBdt: number;
  /** For overage lines: the usage month ("YYYY-MM") being billed. */
  period?: string;
  orders?: number;
}

export interface Invoice {
  id: string;
  number: string;
  sellerId: string;
  status: InvoiceStatus;
  plan: PlanId;
  cycle: Cycle;
  lines: InvoiceLine[];
  subtotalBdt: number;
  /** Unused value of the plan being replaced. */
  prorationCreditBdt: number;
  /** Account credit balance pulled into this invoice. */
  balanceCreditBdt: number;
  creditAppliedBdt: number;
  totalBdt: number;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  paymentMethod: PaymentMethod | null;
}

export interface Payment {
  id: string;
  invoiceId: string;
  sellerId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountBdt: number;
  /** bKash/Nagad TrxID or the gateway's bank transaction id. */
  reference: string | null;
  payerPhone: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
const s = (v: unknown) => String(v);
const sn = (v: unknown) => (v == null ? null : String(v));

function invoiceFromRow(r: Row): Invoice {
  return {
    id: s(r.id),
    number: s(r.number),
    sellerId: s(r.seller_id),
    status: s(r.status) as InvoiceStatus,
    plan: s(r.plan) as PlanId,
    cycle: s(r.cycle) as Cycle,
    lines: JSON.parse(s(r.lines_json)) as InvoiceLine[],
    subtotalBdt: Number(r.subtotal_bdt),
    prorationCreditBdt: Number(r.proration_credit_bdt),
    balanceCreditBdt: Number(r.balance_credit_bdt),
    creditAppliedBdt: Number(r.credit_applied_bdt),
    totalBdt: Number(r.total_bdt),
    createdAt: s(r.created_at),
    expiresAt: s(r.expires_at),
    paidAt: sn(r.paid_at),
    paymentMethod: sn(r.payment_method) as PaymentMethod | null,
  };
}

function paymentFromRow(r: Row): Payment {
  return {
    id: s(r.id),
    invoiceId: s(r.invoice_id),
    sellerId: s(r.seller_id),
    method: s(r.method) as PaymentMethod,
    status: s(r.status) as PaymentStatus,
    amountBdt: Number(r.amount_bdt),
    reference: sn(r.reference),
    payerPhone: sn(r.payer_phone),
    detail: sn(r.detail),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export class DuplicateReferenceError extends Error {
  constructor() {
    super('This transaction id has already been used');
    this.name = 'DuplicateReferenceError';
  }
}

/** Invoices, payments, overage billing and admin sessions. Shares the Store's SQLite connection. */
export class BillingRepo {
  constructor(private readonly db: DatabaseSync) {}

  // ---------------------------------------------------------------- invoices

  /** Sequential, human-readable numbers per year: SN-2026-00001. */
  nextInvoiceNumber(year: number): string {
    const prefix = `SN-${year}-`;
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?').get(`${prefix}%`) as Row;
    return `${prefix}${String(Number(r.n) + 1).padStart(5, '0')}`;
  }

  insertInvoice(i: Invoice): Invoice {
    this.db
      .prepare(
        `INSERT INTO invoices (id, number, seller_id, status, plan, cycle, lines_json, subtotal_bdt, proration_credit_bdt,
           balance_credit_bdt, credit_applied_bdt, total_bdt, created_at, expires_at, paid_at, payment_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id,
        i.number,
        i.sellerId,
        i.status,
        i.plan,
        i.cycle,
        JSON.stringify(i.lines),
        i.subtotalBdt,
        i.prorationCreditBdt,
        i.balanceCreditBdt,
        i.creditAppliedBdt,
        i.totalBdt,
        i.createdAt,
        i.expiresAt,
        i.paidAt,
        i.paymentMethod,
      );
    return i;
  }

  getInvoice(id: string): Invoice | null {
    const r = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Row | undefined;
    return r ? invoiceFromRow(r) : null;
  }

  listInvoices(sellerId: string, limit = 50): Invoice[] {
    return (
      this.db.prepare('SELECT * FROM invoices WHERE seller_id = ? ORDER BY created_at DESC, number DESC LIMIT ?').all(sellerId, limit) as Row[]
    ).map(invoiceFromRow);
  }

  listRecentInvoices(limit = 30): Invoice[] {
    return (this.db.prepare("SELECT * FROM invoices WHERE status != 'void' ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(
      invoiceFromRow,
    );
  }

  /** Keeps at most one open invoice per seller, so credit and overage are never claimed twice. */
  voidOpenInvoices(sellerId: string): void {
    this.db.prepare("UPDATE invoices SET status = 'void' WHERE seller_id = ? AND status = 'open'").run(sellerId);
  }

  markInvoicePaid(id: string, paidAt: string, method: PaymentMethod): void {
    this.db.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, payment_method = ? WHERE id = ?").run(paidAt, method, id);
  }

  revenueSince(sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(total_bdt), 0) AS n FROM invoices WHERE status = 'paid' AND paid_at >= ?")
      .get(sinceIso) as Row;
    return Number(r.n);
  }

  // ---------------------------------------------------------------- payments

  insertPayment(p: Payment): Payment {
    try {
      this.db
        .prepare(
          `INSERT INTO payments (id, invoice_id, seller_id, method, status, amount_bdt, reference, payer_phone, detail, raw_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(p.id, p.invoiceId, p.sellerId, p.method, p.status, p.amountBdt, p.reference, p.payerPhone, p.detail, p.createdAt, p.updatedAt);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: payments\.method, payments\.reference/.test(err.message)) {
        throw new DuplicateReferenceError();
      }
      throw err;
    }
    return p;
  }

  getPayment(id: string): Payment | null {
    const r = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
    return r ? paymentFromRow(r) : null;
  }

  updatePayment(
    id: string,
    patch: { status?: PaymentStatus; reference?: string | null; detail?: string | null; raw?: unknown },
    updatedAt: string,
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const values: SQLInputValue[] = [updatedAt];
    if (patch.status !== undefined) (sets.push('status = ?'), values.push(patch.status));
    if (patch.reference !== undefined) (sets.push('reference = ?'), values.push(patch.reference));
    if (patch.detail !== undefined) (sets.push('detail = ?'), values.push(patch.detail));
    if (patch.raw !== undefined) (sets.push('raw_json = ?'), values.push(JSON.stringify(patch.raw)));
    try {
      this.db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: payments\.method, payments\.reference/.test(err.message)) {
        throw new DuplicateReferenceError();
      }
      throw err;
    }
  }

  listInvoicePayments(invoiceId: string): Payment[] {
    return (this.db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at DESC').all(invoiceId) as Row[]).map(paymentFromRow);
  }

  listPaymentsByStatus(status: PaymentStatus, limit = 100): Payment[] {
    return (
      this.db.prepare('SELECT * FROM payments WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(status, limit) as Row[]
    ).map(paymentFromRow);
  }

  // ----------------------------------------------------------------- overage

  /** Completed months with overage not yet on a paid invoice. */
  unbilledOverage(sellerId: string, beforePeriod: string): Array<{ period: string; orders: number }> {
    const rows = this.db
      .prepare(
        `SELECT period, overage_orders FROM usage
         WHERE seller_id = ? AND period < ? AND overage_orders > 0 AND overage_invoice_id IS NULL ORDER BY period`,
      )
      .all(sellerId, beforePeriod) as Row[];
    return rows.map((r) => ({ period: s(r.period), orders: Number(r.overage_orders) }));
  }

  markOverageBilled(sellerId: string, periods: string[], invoiceId: string): void {
    const stmt = this.db.prepare('UPDATE usage SET overage_invoice_id = ? WHERE seller_id = ? AND period = ? AND overage_invoice_id IS NULL');
    for (const period of periods) stmt.run(invoiceId, sellerId, period);
  }

  // ----------------------------------------------------------- admin sessions

  createAdminSession(tokenHash: string, createdAt: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(tokenHash, createdAt, expiresAt);
  }

  isAdminSession(tokenHash: string, nowIso: string): boolean {
    return this.db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, nowIso) !== undefined;
  }

  deleteAdminSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
  }
}
