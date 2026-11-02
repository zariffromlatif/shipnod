import type { SmsProvider } from '../confirmation/sms.js';
import { LEAD_STATUSES, type Lead, type LeadRepo, type LeadStatus } from '../db/leads-repo.js';
import { normalizeBdPhone, toE164 } from '../domain/phone.js';
import { newId } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import type { ShipnodService } from './shipnod.js';

export const MONTHLY_ORDER_BUCKETS = ['<300', '300-1000', '1000-3000', '3000+'] as const;
export const LEAD_COURIERS = ['steadfast', 'pathao', 'redx', 'other'] as const;
export const LEAD_CHANNELS = ['facebook', 'website', 'both'] as const;
/** Founder alert SMS per rolling 24 hours, so a spam burst can't run up the SMS bill. */
export const MAX_ALERTS_PER_DAY = 20;
const DAY = 86_400_000;

export interface LeadInput {
  name: string;
  shopName: string;
  phone: string;
  monthlyOrders?: string;
  couriers?: string[];
  channel?: string;
  source?: string;
  /** Hidden honeypot field; humans never fill it. */
  honeypot?: string;
}

export type LeadSubmitResult =
  | { status: 'created'; lead: Lead }
  /** Same phone asked within 24h: details refreshed, no second alert. */
  | { status: 'duplicate'; lead: Lead }
  /** Already a seller: send them to the login page instead. */
  | { status: 'existing_seller' }
  /** Bot filled the honeypot: answer like a success, store nothing. */
  | { status: 'ignored' };

export interface LeadDeps {
  repo: LeadRepo;
  service: ShipnodService;
  sms: SmsProvider;
  publicBaseUrl: string;
  /** Founder's phone for new-lead SMS; null = no alerts. */
  alertPhone: string | null;
  now?: () => Date;
}

const clip = (v: string | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Pilot requests from the public landing page, and the founder's follow-up on them. */
export class LeadService {
  private readonly now: () => Date;

  constructor(private readonly deps: LeadDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async submit(input: LeadInput): Promise<LeadSubmitResult> {
    if (input.honeypot && input.honeypot.trim() !== '') return { status: 'ignored' };

    const name = clip(input.name, 80);
    const shopName = clip(input.shopName, 80);
    if (!name) throw new AppError(400, 'invalid_name', 'Name is required');
    if (!shopName) throw new AppError(400, 'invalid_shop', 'Shop or page name is required');
    const phone = normalizeBdPhone(input.phone);
    if (!phone) throw new AppError(400, 'invalid_phone', 'Not a valid Bangladeshi mobile number');
    if (this.deps.service.findSellerByPhone(phone)) return { status: 'existing_seller' };

    const details = {
      name,
      shopName,
      monthlyOrders: (MONTHLY_ORDER_BUCKETS as readonly string[]).includes(input.monthlyOrders ?? '') ? input.monthlyOrders! : null,
      couriers: (input.couriers ?? []).filter((c): c is (typeof LEAD_COURIERS)[number] => (LEAD_COURIERS as readonly string[]).includes(c)),
      channel: (LEAD_CHANNELS as readonly string[]).includes(input.channel ?? '') ? input.channel! : null,
    };
    const now = this.now();
    const nowIso = now.toISOString();

    const recent = this.deps.repo.recentByPhone(phone, new Date(now.getTime() - DAY).toISOString());
    if (recent) {
      this.deps.repo.refresh(recent.id, details, nowIso);
      return { status: 'duplicate', lead: this.deps.repo.get(recent.id)! };
    }

    const lead = this.deps.repo.insert({
      id: newId('lead'),
      ...details,
      phone,
      source: clip(input.source, 60).replace(/[^\w.\-:/ ]/g, '') || null,
      status: 'new',
      sellerId: null,
      alerted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.alert(lead, now);
    return { status: 'created', lead: this.deps.repo.get(lead.id)! };
  }

  private async alert(lead: Lead, now: Date): Promise<void> {
    const to = this.deps.alertPhone;
    if (!to) return;
    if (this.deps.repo.alertsSince(new Date(now.getTime() - DAY).toISOString()) >= MAX_ALERTS_PER_DAY) return;
    const orders = lead.monthlyOrders ? `, ${lead.monthlyOrders} orders/mo` : '';
    const result = await this.deps.sms.send({
      to,
      text: `Shipnod lead: ${lead.shopName.slice(0, 30)} (${lead.phone}${orders}). ${this.deps.publicBaseUrl}/admin/leads`,
    });
    if (result.ok) this.deps.repo.markAlerted(lead.id);
  }

  list(status?: LeadStatus): Lead[] {
    return this.deps.repo.list(status);
  }

  counts() {
    return this.deps.repo.counts();
  }

  get(id: string): Lead {
    const lead = this.deps.repo.get(id);
    if (!lead) throw notFound('Lead');
    return lead;
  }

  setStatus(id: string, status: string): Lead {
    const lead = this.get(id);
    if (!(LEAD_STATUSES as readonly string[]).includes(status) || status === 'converted') {
      throw new AppError(400, 'invalid_status', 'Use contacted, lost or new');
    }
    this.deps.repo.setStatus(lead.id, status as LeadStatus, this.now().toISOString());
    return this.get(id);
  }

  markConverted(id: string, sellerId: string): void {
    this.deps.repo.setStatus(this.get(id).id, 'converted', this.now().toISOString(), sellerId);
  }

  /** WhatsApp chat with the lead, greeting pre-filled. */
  whatsappUrl(lead: Lead): string {
    const text = `আসসালামু আলাইকুম ${lead.name}, Shipnod-এ ১৪ দিনের ফ্রি পাইলটের জন্য আপনার অনুরোধ পেয়েছি। কখন কথা বলা যাবে?`;
    return `https://wa.me/${toE164(lead.phone).slice(1)}?text=${encodeURIComponent(text)}`;
  }
}
