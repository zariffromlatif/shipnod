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
 * RedX open API. Every call carries `API-ACCESS-TOKEN: Bearer <token>`.
 * Notes from integrators: phones must be "01XXXXXXXXX" (not +880), and `pickup_store_id` is NOT the
 * shop id — look it up from the pickup-stores endpoint. Verify against the sandbox before go-live.
 */
export interface RedxCredentials {
  accessToken: string;
  pickupStoreId: number;
}

export const REDX_BASE_URL = 'https://openapi.redx.com.bd/v1.0.0-beta';
export const REDX_SANDBOX_URL = 'https://sandbox.redx.com.bd/v1.0.0-beta';

export function mapRedxStatus(raw: string): NormalizedDeliveryStatus {
  const s = raw.toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (s === 'returned') return 'returned';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'pickup-pending' || s === 'pickup-requested') return 'pending';
  if (s) return 'in_transit';
  return 'unknown';
}

export class RedxAdapter implements CourierAdapter {
  readonly id = 'redx' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    private readonly creds: RedxCredentials,
    opts: { sandbox?: boolean; baseUrl?: string; fetch?: typeof fetch } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? (opts.sandbox ? REDX_SANDBOX_URL : REDX_BASE_URL);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'API-ACCESS-TOKEN': `Bearer ${this.creds.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createParcel(s: ShipmentRequest): Promise<BookingResult> {
    if (!s.area?.areaId || !s.area.areaName) {
      throw new CourierApiError('redx', 'RedX needs area.areaId and area.areaName (delivery area)');
    }
    const res = await this.fetchImpl(`${this.baseUrl}/parcel`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        customer_name: s.recipientName,
        customer_phone: s.recipientPhone,
        delivery_area: s.area.areaName,
        delivery_area_id: s.area.areaId,
        customer_address: s.recipientAddress,
        merchant_invoice_id: s.invoice,
        cash_collection_amount: String(Math.round(s.codAmount)),
        parcel_weight: Math.round((s.weightKg ?? 0.5) * 1000),
        instruction: s.note ?? '',
        value: String(Math.round(s.codAmount)),
        pickup_store_id: this.creds.pickupStoreId,
        parcel_details_json: [],
      }),
    });
    const body = await readJson(res);
    if (!res.ok || !isRecord(body) || body.tracking_id == null) {
      throw new CourierApiError('redx', 'create parcel failed', res.status, body);
    }
    const trackingId = String(body.tracking_id);
    return { consignmentId: trackingId, trackingCode: trackingId, rawStatus: 'pickup-pending' };
  }

  async getStatus(consignmentId: string): Promise<StatusResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/parcel/info/${encodeURIComponent(consignmentId)}`, {
      headers: this.headers(),
    });
    const body = await readJson(res);
    const parcel = isRecord(body) && isRecord(body.parcel) ? body.parcel : null;
    if (!res.ok || !parcel || typeof parcel.status !== 'string') {
      throw new CourierApiError('redx', 'parcel info failed', res.status, body);
    }
    return { status: mapRedxStatus(parcel.status), rawStatus: parcel.status };
  }
}
