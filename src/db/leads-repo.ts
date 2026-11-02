import type { DatabaseSync } from 'node:sqlite';

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Lead {
  id: string;
  name: string;
  shopName: string;
  /** Canonical "01XXXXXXXXX". */
  phone: string;
  /** Bucket such as "300-1000"; null if not given. */
  monthlyOrders: string | null;
  couriers: string[];
  /** facebook | website | both */
  channel: string | null;
  /** Where the visitor came from (?ref= / utm_source), e.g. the Facebook group a post was in. */
  source: string | null;
  status: LeadStatus;
  sellerId: string | null;
  /** Whether the founder was texted about this lead. */
  alerted: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
const sn = (v: unknown) => (v == null ? null : String(v));

function leadFromRow(r: Row): Lead {
  return {
    id: String(r.id),
    name: String(r.name),
    shopName: String(r.shop_name),
    phone: String(r.phone),
    monthlyOrders: sn(r.monthly_orders),
    couriers: r.couriers ? String(r.couriers).split(',').filter(Boolean) : [],
    channel: sn(r.channel),
    source: sn(r.source),
    status: String(r.status) as LeadStatus,
    sellerId: sn(r.seller_id),
    alerted: Number(r.alerted) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Pilot requests. Shares the Store's SQLite connection. */
export class LeadRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(l: Lead): Lead {
    this.db
      .prepare(
        `INSERT INTO leads (id, name, shop_name, phone, monthly_orders, couriers, channel, source, status, seller_id, alerted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.id,
        l.name,
        l.shopName,
        l.phone,
        l.monthlyOrders,
        l.couriers.join(','),
        l.channel,
        l.source,
        l.status,
        l.sellerId,
        l.alerted ? 1 : 0,
        l.createdAt,
        l.updatedAt,
      );
    return l;
  }

  get(id: string): Lead | null {
    const r = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Row | undefined;
    return r ? leadFromRow(r) : null;
  }

  /** Most recent request from this phone since the given time. */
  recentByPhone(phone: string, sinceIso: string): Lead | null {
    const r = this.db
      .prepare('SELECT * FROM leads WHERE phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
      .get(phone, sinceIso) as Row | undefined;
    return r ? leadFromRow(r) : null;
  }

  /** Refreshes the details of a repeat request (they may have corrected something). */
  refresh(id: string, l: Pick<Lead, 'name' | 'shopName' | 'monthlyOrders' | 'couriers' | 'channel'>, updatedAt: string): void {
    this.db
      .prepare('UPDATE leads SET name = ?, shop_name = ?, monthly_orders = ?, couriers = ?, channel = ?, updated_at = ? WHERE id = ?')
      .run(l.name, l.shopName, l.monthlyOrders, l.couriers.join(','), l.channel, updatedAt, id);
  }

  list(status?: LeadStatus, limit = 200): Lead[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(leadFromRow);
  }

  counts(): Record<LeadStatus, number> {
    const out: Record<LeadStatus, number> = { new: 0, contacted: 0, converted: 0, lost: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all() as Row[]) {
      out[String(r.status) as LeadStatus] = Number(r.n);
    }
    return out;
  }

  setStatus(id: string, status: LeadStatus, updatedAt: string, sellerId?: string): void {
    this.db
      .prepare('UPDATE leads SET status = ?, seller_id = COALESCE(?, seller_id), updated_at = ? WHERE id = ?')
      .run(status, sellerId ?? null, updatedAt, id);
  }

  markAlerted(id: string): void {
    this.db.prepare('UPDATE leads SET alerted = 1 WHERE id = ?').run(id);
  }

  alertsSince(sinceIso: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE alerted = 1 AND created_at >= ?').get(sinceIso) as Row;
    return Number(r.n);
  }
}
