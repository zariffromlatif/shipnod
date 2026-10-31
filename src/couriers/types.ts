import type { CourierId } from '../domain/types.js';

export interface ShipmentRequest {
  /** Our order id; sent as the merchant invoice / order id so parcels can be traced back. */
  invoice: string;
  recipientName: string;
  /** Canonical "01XXXXXXXXX". */
  recipientPhone: string;
  recipientAddress: string;
  codAmount: number;
  itemDescription?: string;
  itemQuantity?: number;
  weightKg?: number;
  note?: string;
  /** Courier-specific area ids. Pathao needs city/zone (area optional); RedX needs a delivery area. */
  area?: {
    cityId?: number;
    zoneId?: number;
    areaId?: number;
    areaName?: string;
  };
}

export interface BookingResult {
  consignmentId: string;
  trackingCode: string | null;
  rawStatus: string;
}

/** Courier statuses collapsed to what Shipnod cares about. */
export type NormalizedDeliveryStatus = 'pending' | 'in_transit' | 'delivered' | 'returned' | 'cancelled' | 'unknown';

export interface StatusResult {
  status: NormalizedDeliveryStatus;
  rawStatus: string;
}

export interface CourierAdapter {
  readonly id: CourierId;
  createParcel(shipment: ShipmentRequest): Promise<BookingResult>;
  getStatus(consignmentId: string, trackingCode?: string | null): Promise<StatusResult>;
}

export class CourierApiError extends Error {
  constructor(
    readonly courier: CourierId,
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown,
  ) {
    super(`[${courier}] ${message}`);
    this.name = 'CourierApiError';
  }
}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
