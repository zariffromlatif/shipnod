import {
  CourierApiError,
  isRecord,
  readJson,
  type BookingResult,
  type CourierAdapter,
  type NormalizedDeliveryStatus,
  type ShipmentRequest,
  type StatusResult,
} from './types.js';

/**
 * Pathao Courier merchant API ("aladdin" v1): OAuth password grant, then bearer calls.
 * Credentials come from the merchant panel's Developers API page. Verify against the sandbox first.
 */
export interface PathaoCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  storeId: number;
}

export const PATHAO_BASE_URL = 'https://api-hermes.pathao.com';
export const PATHAO_SANDBOX_URL = 'https://courier-api-sandbox.pathao.com';

const DELIVERED = new Set(['delivered', 'partial_delivery', 'payment_invoice']);
const RETURNED = new Set(['return', 'paid_return', 'returned']);
const PENDING = new Set(['pending', 'pickup_requested', 'assigned_for_pickup']);
const CANCELLED = new Set(['pickup_cancelled', 'cancelled']);

export function mapPathaoStatus(raw: string): NormalizedDeliveryStatus {
  const s = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (DELIVERED.has(s)) return 'delivered';
  if (RETURNED.has(s)) return 'returned';
  if (CANCELLED.has(s)) return 'cancelled';
  if (PENDING.has(s)) return 'pending';
  if (s) return 'in_transit';
  return 'unknown';
}

export class PathaoAdapter implements CourierAdapter {
  readonly id = 'pathao' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: PathaoCredentials,
    opts: { sandbox?: boolean; baseUrl?: string; fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? (opts.sandbox ? PATHAO_SANDBOX_URL : PATHAO_BASE_URL);
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private readonly now: () => number;

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/aladdin/api/v1/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        username: this.creds.username,
        password: this.creds.password,
        grant_type: 'password',
      }),
    });
    const body = await readJson(res);
    if (!res.ok || !isRecord(body) || typeof body.access_token !== 'string') {
      throw new CourierApiError('pathao', 'issue-token failed', res.status, body);
    }
    const ttlSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: this.now() + ttlSeconds * 1000 };
    return this.token.value;
  }

  private async authed(path: string, init: RequestInit = {}): Promise<{ res: Response; body: unknown }> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    return { res, body: await readJson(res) };
  }

  async createParcel(s: ShipmentRequest): Promise<BookingResult> {
    const payload: Record<string, unknown> = {
      store_id: this.creds.storeId,
      merchant_order_id: s.invoice,
      recipient_name: s.recipientName,
      recipient_phone: s.recipientPhone,
      recipient_address: s.recipientAddress,
      delivery_type: 48, // normal delivery
      item_type: 2, // parcel
      special_instruction: s.note ?? '',
      item_quantity: s.itemQuantity ?? 1,
      item_weight: Math.min(10, Math.max(0.5, s.weightKg ?? 0.5)),
      amount_to_collect: Math.round(s.codAmount),
      item_description: s.itemDescription ?? '',
    };
    if (s.area?.cityId) payload.recipient_city = s.area.cityId;
    if (s.area?.zoneId) payload.recipient_zone = s.area.zoneId;
    if (s.area?.areaId) payload.recipient_area = s.area.areaId;

    const { res, body } = await this.authed('/aladdin/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    if (!res.ok || !data || data.consignment_id == null) {
      throw new CourierApiError('pathao', 'create order failed', res.status, body);
    }
    return {
      consignmentId: String(data.consignment_id),
      trackingCode: String(data.consignment_id),
      rawStatus: String(data.order_status ?? 'Pending'),
    };
  }

  async getStatus(consignmentId: string): Promise<StatusResult> {
    const { res, body } = await this.authed(`/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`);
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    const raw = data ? (data.order_status_slug ?? data.order_status) : undefined;
    if (!res.ok || typeof raw !== 'string') {
      throw new CourierApiError('pathao', 'order info failed', res.status, body);
    }
    return { status: mapPathaoStatus(raw), rawStatus: raw };
  }
}
