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
 * Steadfast Courier merchant API.
 * Base URL and endpoints follow Steadfast's merchant API (portal.packzy.com/api/v1) as used by the
 * community SDKs; confirm field names against the docs in your Steadfast merchant panel before go-live.
 */
export interface SteadfastCredentials {
  apiKey: string;
  secretKey: string;
}

export const STEADFAST_BASE_URL = 'https://portal.packzy.com/api/v1';

export function mapSteadfastStatus(raw: string): NormalizedDeliveryStatus {
  const s = raw.toLowerCase();
  if (s.startsWith('delivered') || s.startsWith('partial_delivered')) return 'delivered';
  // A booked Steadfast parcel that ends "cancelled" was not accepted by the customer and goes back to the merchant.
  if (s.startsWith('cancelled')) return 'returned';
  if (s === 'in_review') return 'pending';
  if (s === 'pending' || s === 'hold') return 'in_transit';
  return 'unknown';
}

export class SteadfastAdapter implements CourierAdapter {
  readonly id = 'steadfast' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: SteadfastCredentials,
    opts: { baseUrl?: string; fetch?: typeof fetch } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? STEADFAST_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private readonly baseUrl: string;

  private headers(): Record<string, string> {
    return {
      'Api-Key': this.creds.apiKey,
      'Secret-Key': this.creds.secretKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createParcel(s: ShipmentRequest): Promise<BookingResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/create_order`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        invoice: s.invoice,
        recipient_name: s.recipientName,
        recipient_phone: s.recipientPhone,
        recipient_address: s.recipientAddress,
        cod_amount: s.codAmount,
        note: s.note ?? '',
        item_description: s.itemDescription ?? '',
      }),
    });
    const body = await readJson(res);
    const consignment = isRecord(body) && isRecord(body.consignment) ? body.consignment : null;
    if (!res.ok || !consignment || consignment.consignment_id == null) {
      throw new CourierApiError('steadfast', 'create_order failed', res.status, body);
    }
    return {
      consignmentId: String(consignment.consignment_id),
      trackingCode: consignment.tracking_code ? String(consignment.tracking_code) : null,
      rawStatus: String(consignment.status ?? 'in_review'),
    };
  }

  async getStatus(consignmentId: string): Promise<StatusResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/status_by_cid/${encodeURIComponent(consignmentId)}`, {
      headers: this.headers(),
    });
    const body = await readJson(res);
    if (!res.ok || !isRecord(body) || typeof body.delivery_status !== 'string') {
      throw new CourierApiError('steadfast', 'status_by_cid failed', res.status, body);
    }
    return { status: mapSteadfastStatus(body.delivery_status), rawStatus: body.delivery_status };
  }
}
