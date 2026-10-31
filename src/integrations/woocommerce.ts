import { z } from 'zod';
import type { OrderInput } from '../domain/types.js';
import { verifyBase64Hmac } from '../lib/crypto.js';

/**
 * WooCommerce "Order created" webhook (WooCommerce → Settings → Advanced → Webhooks, API v3).
 * Signature: header X-WC-Webhook-Signature = base64(HMAC-SHA256(secret, raw body)).
 */
const address = z
  .object({
    first_name: z.string().optional().default(''),
    last_name: z.string().optional().default(''),
    address_1: z.string().optional().default(''),
    address_2: z.string().optional().default(''),
    city: z.string().optional().default(''),
    state: z.string().optional().default(''),
    phone: z.string().optional().default(''),
  })
  .partial()
  .passthrough();

export const wooOrderSchema = z
  .object({
    id: z.number(),
    number: z.union([z.string(), z.number()]).optional(),
    status: z.string().optional(),
    total: z.string(),
    payment_method: z.string().optional().default(''),
    customer_note: z.string().optional().default(''),
    date_created_gmt: z.string().optional(),
    billing: address.optional().default({}),
    shipping: address.optional().default({}),
    line_items: z
      .array(z.object({ name: z.string(), quantity: z.number(), price: z.union([z.number(), z.string()]) }).passthrough())
      .optional()
      .default([]),
  })
  .passthrough();

export type WooOrder = z.infer<typeof wooOrderSchema>;

export function verifyWooSignature(secret: string, rawBody: string, signature: string | undefined | null): boolean {
  return verifyBase64Hmac(secret, rawBody, signature);
}

function joinParts(...parts: Array<string | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join(', ');
}

export function mapWooOrder(raw: unknown): OrderInput {
  const o = wooOrderSchema.parse(raw);
  const ship = o.shipping.address_1 ? o.shipping : o.billing;
  const name = joinParts(`${ship.first_name ?? ''} ${ship.last_name ?? ''}`) || joinParts(`${o.billing.first_name ?? ''} ${o.billing.last_name ?? ''}`);
  const isCod = o.payment_method === 'cod';
  return {
    externalId: String(o.id),
    source: 'woocommerce',
    customerName: name || 'Customer',
    phone: o.shipping.phone || o.billing.phone || '',
    address: joinParts(ship.address_1, ship.address_2, ship.city),
    district: ship.state || ship.city || undefined,
    codAmount: isCod ? Number(o.total) : 0,
    items: o.line_items.map((li) => ({ name: li.name, quantity: li.quantity, unitPrice: Number(li.price) })),
    note: o.customer_note || undefined,
    placedAt: o.date_created_gmt ? new Date(`${o.date_created_gmt}Z`) : undefined,
  };
}
