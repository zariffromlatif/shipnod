import { z } from 'zod';
import type { OrderInput } from '../domain/types.js';
import { verifyBase64Hmac } from '../lib/crypto.js';

/**
 * Shopify "orders/create" webhook.
 * Signature: header X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(app/webhook secret, raw body)).
 */
const shopifyAddress = z
  .object({
    name: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .passthrough();

export const shopifyOrderSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    total_price: z.string(),
    total_outstanding: z.string().nullish(),
    financial_status: z.string().nullish(),
    gateway: z.string().nullish(),
    payment_gateway_names: z.array(z.string()).nullish(),
    phone: z.string().nullish(),
    note: z.string().nullish(),
    created_at: z.string().optional(),
    customer: z
      .object({ first_name: z.string().nullish(), last_name: z.string().nullish(), phone: z.string().nullish() })
      .passthrough()
      .nullish(),
    shipping_address: shopifyAddress.nullish(),
    billing_address: shopifyAddress.nullish(),
    line_items: z
      .array(z.object({ title: z.string(), quantity: z.number(), price: z.string() }).passthrough())
      .optional()
      .default([]),
  })
  .passthrough();

export function verifyShopifySignature(secret: string, rawBody: string, signature: string | undefined | null): boolean {
  return verifyBase64Hmac(secret, rawBody, signature);
}

const COD_GATEWAY = /cash on delivery|\bcod\b/i;

export function mapShopifyOrder(raw: unknown): OrderInput {
  const o = shopifyOrderSchema.parse(raw);
  const addr = o.shipping_address ?? o.billing_address ?? {};
  const gateways = [o.gateway ?? '', ...(o.payment_gateway_names ?? [])];
  const isCod = gateways.some((g) => COD_GATEWAY.test(g)) && o.financial_status !== 'paid';
  const outstanding = Number(o.total_outstanding ?? o.total_price);
  const name =
    addr.name?.trim() ||
    `${o.customer?.first_name ?? ''} ${o.customer?.last_name ?? ''}`.trim() ||
    'Customer';
  return {
    externalId: String(o.id),
    source: 'shopify',
    customerName: name,
    phone: addr.phone || o.phone || o.customer?.phone || '',
    address: [addr.address1, addr.address2, addr.city].map((p) => p?.trim()).filter(Boolean).join(', '),
    district: addr.province || addr.city || undefined,
    codAmount: isCod ? outstanding : 0,
    items: o.line_items.map((li) => ({ name: li.title, quantity: li.quantity, unitPrice: Number(li.price) })),
    note: o.note || undefined,
    placedAt: o.created_at ? new Date(o.created_at) : undefined,
  };
}
