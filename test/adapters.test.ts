import { describe, expect, it } from 'vitest';
import { mapPathaoStatus, PathaoAdapter } from '../src/couriers/pathao.js';
import { mapRedxStatus, RedxAdapter } from '../src/couriers/redx.js';
import { createCourierAdapter } from '../src/couriers/registry.js';
import { mapSteadfastStatus, SteadfastAdapter } from '../src/couriers/steadfast.js';
import { CourierApiError, type ShipmentRequest } from '../src/couriers/types.js';
import { mapShopifyOrder } from '../src/integrations/shopify.js';
import { mapWooOrder } from '../src/integrations/woocommerce.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const shipment: ShipmentRequest = {
  invoice: 'ord_123',
  recipientName: 'Karim',
  recipientPhone: '01712345678',
  recipientAddress: 'House 1, Road 2, Mirpur 10, Dhaka',
  codAmount: 1450,
  itemDescription: 'Panjabi x1',
  area: { cityId: 1, zoneId: 52, areaId: 1201, areaName: 'Mirpur 10' },
};

describe('Steadfast', () => {
  it('creates orders with key headers and maps the consignment', async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: { status: 200, consignment: { consignment_id: 987, tracking_code: 'SF987', status: 'in_review' } },
    }));
    const a = new SteadfastAdapter({ apiKey: 'k', secretKey: 's' }, { fetch: fn });
    expect(await a.createParcel(shipment)).toEqual({ consignmentId: '987', trackingCode: 'SF987', rawStatus: 'in_review' });
    expect(calls[0]).toMatchObject({
      url: 'https://portal.packzy.com/api/v1/create_order',
      method: 'POST',
      headers: { 'api-key': 'k', 'secret-key': 's' },
      body: { invoice: 'ord_123', recipient_phone: '01712345678', cod_amount: 1450 },
    });
  });

  it('raises CourierApiError on failures', async () => {
    const { fn } = fakeFetch(() => ({ status: 422, body: { errors: { recipient_phone: ['invalid'] } } }));
    await expect(new SteadfastAdapter({ apiKey: 'k', secretKey: 's' }, { fetch: fn }).createParcel(shipment)).rejects.toBeInstanceOf(
      CourierApiError,
    );
  });

  it('maps statuses', () => {
    expect(mapSteadfastStatus('delivered')).toBe('delivered');
    expect(mapSteadfastStatus('partial_delivered_approval_pending')).toBe('delivered');
    expect(mapSteadfastStatus('cancelled')).toBe('returned');
    expect(mapSteadfastStatus('in_review')).toBe('pending');
    expect(mapSteadfastStatus('hold')).toBe('in_transit');
  });
});

describe('Pathao', () => {
  it('fetches a token once and books with bearer auth', async () => {
    const { fn, calls } = fakeFetch((c) =>
      c.url.endsWith('/issue-token')
        ? { body: { access_token: 'tok', expires_in: 3600 } }
        : { body: { code: 200, data: { consignment_id: 'DL1234', order_status: 'Pending' } } },
    );
    const a = new PathaoAdapter(
      { clientId: 'id', clientSecret: 'sec', username: 'u@x.com', password: 'p', storeId: 77 },
      { sandbox: true, fetch: fn },
    );
    await a.createParcel(shipment);
    await a.createParcel({ ...shipment, invoice: 'ord_124' });
    expect(calls.filter((c) => c.url.endsWith('/issue-token'))).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token');
    expect(calls[1]).toMatchObject({
      url: 'https://courier-api-sandbox.pathao.com/aladdin/api/v1/orders',
      headers: { authorization: 'Bearer tok' },
      body: { store_id: 77, merchant_order_id: 'ord_123', recipient_city: 1, recipient_zone: 52, amount_to_collect: 1450, item_weight: 0.5 },
    });
  });

  it('maps statuses', () => {
    expect(mapPathaoStatus('Delivered')).toBe('delivered');
    expect(mapPathaoStatus('Partial_Delivery')).toBe('delivered');
    expect(mapPathaoStatus('Return')).toBe('returned');
    expect(mapPathaoStatus('Pickup_Requested')).toBe('pending');
    expect(mapPathaoStatus('At_the_Sorting_HUB')).toBe('in_transit');
  });
});

describe('RedX', () => {
  it('books with the access-token header and grams', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { tracking_id: '22A1B2C3' } }));
    const a = new RedxAdapter({ accessToken: 'jwt', pickupStoreId: 5 }, { fetch: fn });
    expect(await a.createParcel(shipment)).toMatchObject({ consignmentId: '22A1B2C3' });
    expect(calls[0]).toMatchObject({
      url: 'https://openapi.redx.com.bd/v1.0.0-beta/parcel',
      headers: { 'api-access-token': 'Bearer jwt' },
      body: { customer_phone: '01712345678', delivery_area_id: 1201, parcel_weight: 500, pickup_store_id: 5, cash_collection_amount: '1450' },
    });
  });

  it('requires a delivery area', async () => {
    const { fn } = fakeFetch(() => ({ body: {} }));
    await expect(new RedxAdapter({ accessToken: 'jwt', pickupStoreId: 5 }, { fetch: fn }).createParcel({ ...shipment, area: undefined })).rejects.toThrow(
      /area/,
    );
  });

  it('maps statuses', () => {
    expect(mapRedxStatus('delivered')).toBe('delivered');
    expect(mapRedxStatus('returned')).toBe('returned');
    expect(mapRedxStatus('delivery-in-progress')).toBe('in_transit');
    expect(mapRedxStatus('pickup-pending')).toBe('pending');
  });
});

describe('registry', () => {
  it('validates credentials', () => {
    expect(() => createCourierAdapter('steadfast', { apiKey: 'k' }, { sandbox: true })).toThrow();
    expect(createCourierAdapter('redx', { accessToken: 't', pickupStoreId: '9' }, { sandbox: true }).id).toBe('redx');
  });
});

describe('store integrations', () => {
  it('maps a WooCommerce COD order', () => {
    const o = mapWooOrder({
      id: 4512,
      total: '1450.00',
      payment_method: 'cod',
      date_created_gmt: '2026-10-31T08:00:00',
      billing: { first_name: 'Karim', last_name: 'Uddin', phone: '+880 1712-345678', address_1: 'House 1, Road 2', city: 'Dhaka' },
      shipping: { first_name: '', address_1: '' },
      line_items: [{ name: 'Panjabi', quantity: 1, price: 1450 }],
      customer_note: 'Call before delivery',
    });
    expect(o).toMatchObject({
      externalId: '4512',
      source: 'woocommerce',
      customerName: 'Karim Uddin',
      phone: '+880 1712-345678',
      address: 'House 1, Road 2, Dhaka',
      codAmount: 1450,
      note: 'Call before delivery',
    });
    expect(o.placedAt?.toISOString()).toBe('2026-10-31T08:00:00.000Z');
  });

  it('treats non-COD WooCommerce orders as prepaid', () => {
    expect(mapWooOrder({ id: 1, total: '900', payment_method: 'bkash' }).codAmount).toBe(0);
  });

  it('maps a Shopify COD order', () => {
    const o = mapShopifyOrder({
      id: 5550001,
      total_price: '2100.00',
      financial_status: 'pending',
      payment_gateway_names: ['Cash on Delivery (COD)'],
      shipping_address: { name: 'Nusrat Jahan', address1: 'Flat 4B, Road 11', city: 'Chattogram', phone: '01811223344' },
      line_items: [{ title: 'Saree', quantity: 1, price: '2100.00' }],
      created_at: '2026-10-31T14:00:00+06:00',
    });
    expect(o).toMatchObject({ externalId: '5550001', customerName: 'Nusrat Jahan', phone: '01811223344', codAmount: 2100 });
  });

  it('treats paid Shopify orders as prepaid', () => {
    const o = mapShopifyOrder({ id: 1, total_price: '500', financial_status: 'paid', gateway: 'bkash' });
    expect(o.codAmount).toBe(0);
  });
});
