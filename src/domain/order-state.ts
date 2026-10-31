import type { OrderStatus } from './types.js';

/**
 * Order lifecycle.
 *
 *   new ──► awaiting_confirmation ──► confirmed ──► booked ──► in_transit ──► delivered
 *    │            │                      ▲  │          │            │
 *    │            ├──► awaiting_advance ─┘  │          └────────────┴──► returned
 *    │            └──► on_hold ─────────────┘
 *    └──► cancelled (from any pre-shipping state)
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['awaiting_confirmation', 'awaiting_advance', 'on_hold', 'confirmed', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'awaiting_advance', 'on_hold', 'cancelled'],
  awaiting_advance: ['confirmed', 'on_hold', 'cancelled'],
  on_hold: ['awaiting_confirmation', 'awaiting_advance', 'confirmed', 'cancelled'],
  confirmed: ['booked', 'on_hold', 'cancelled', 'delivered', 'returned'],
  booked: ['in_transit', 'delivered', 'returned', 'cancelled'],
  in_transit: ['delivered', 'returned'],
  delivered: [],
  returned: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Cannot move order from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses in which the parcel is with a courier and its outcome should be synced. */
export const SHIPPED_STATUSES: readonly OrderStatus[] = ['booked', 'in_transit'];
