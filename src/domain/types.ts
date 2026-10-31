export const COURIER_IDS = ['steadfast', 'pathao', 'redx'] as const;
export type CourierId = (typeof COURIER_IDS)[number];

export const ORDER_STATUSES = [
  'new',
  'awaiting_confirmation',
  'awaiting_advance',
  'on_hold',
  'confirmed',
  'cancelled',
  'booked',
  'in_transit',
  'delivered',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderSource = 'manual' | 'api' | 'csv' | 'woocommerce' | 'shopify';

/** What happened to a parcel in the end. This is what feeds the shared network. */
export type DeliveryOutcome = 'delivered' | 'returned' | 'cancelled';

export interface OrderItem {
  name: string;
  quantity: number;
  /** Unit price in BDT. */
  unitPrice: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RiskAction = 'auto_ship' | 'confirm' | 'advance_payment' | 'hold';

export interface RiskReason {
  code: string;
  points: number;
  message: string;
  messageBn: string;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  action: RiskAction;
  reasons: RiskReason[];
  /** Delivered / (delivered + returned) across the network, or null if never seen. */
  deliverySuccessRate: number | null;
  /** Orders with a known outcome for this phone across the network. */
  ordersSeen: number;
}

/** Input accepted from the API, CSV import and store webhooks. */
export interface OrderInput {
  externalId?: string;
  source: OrderSource;
  customerName: string;
  phone: string;
  address: string;
  district?: string;
  /** Amount the courier must collect, in BDT. 0 for prepaid orders. */
  codAmount: number;
  items: OrderItem[];
  note?: string;
  /** When the customer placed the order; defaults to now. */
  placedAt?: Date;
}

export interface Order {
  id: string;
  sellerId: string;
  externalId: string | null;
  source: OrderSource;
  customerName: string;
  /** Canonical "01XXXXXXXXX" form, or the raw input if it could not be normalized. */
  phone: string;
  phoneValid: boolean;
  address: string;
  district: string | null;
  codAmount: number;
  items: OrderItem[];
  note: string | null;
  status: OrderStatus;
  risk: RiskAssessment | null;
  confirmCode: string | null;
  confirmExpiresAt: string | null;
  courier: CourierId | null;
  consignmentId: string | null;
  trackingCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryHistory {
  delivered: number;
  returned: number;
  /** Customer cancelled at confirmation, or refused before pickup. */
  cancelled: number;
}
