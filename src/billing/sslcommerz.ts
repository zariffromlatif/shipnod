/**
 * SSLCommerz hosted checkout (v4): one payment page for bKash, Nagad, Rocket, cards and internet banking.
 *
 *   1. initSession()  POST /gwprocess/v4/api.php           → GatewayPageURL (redirect the seller there)
 *   2. SSLCommerz POSTs back to success / fail / cancel (browser) and ipn (server) with `val_id`
 *   3. validate()     GET  /validator/api/validationserverAPI.php?val_id=…  → the authoritative result
 *
 * Only step 3 is trusted: a browser redirect or IPN body can be forged, the validation call cannot.
 * Field names follow SSLCommerz's v4 API as used by its official SDKs; check them against
 * developer.sslcommerz.com with your sandbox store before going live.
 */
export const SSLCOMMERZ_SANDBOX_URL = 'https://sandbox.sslcommerz.com';
export const SSLCOMMERZ_LIVE_URL = 'https://securepay.sslcommerz.com';

export interface SslCommerzConfig {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  fetch?: typeof fetch;
}

export interface SessionRequest {
  tranId: string;
  amountBdt: number;
  productName: string;
  customer: { name: string; phone: string; email: string };
  urls: { success: string; fail: string; cancel: string; ipn: string };
}

export interface ValidationResult {
  /** VALID / VALIDATED mean paid; anything else (INVALID_TRANSACTION, FAILED…) does not. */
  status: string;
  tranId: string;
  amount: number;
  currency: string;
  /** "1" = SSLCommerz flagged the transaction as risky; hold for manual review. */
  riskLevel: string;
  bankTranId: string | null;
  cardType: string | null;
  raw: Record<string, unknown>;
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

export class SslCommerzClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SslCommerzConfig) {
    this.baseUrl = config.sandbox ? SSLCOMMERZ_SANDBOX_URL : SSLCOMMERZ_LIVE_URL;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async initSession(req: SessionRequest): Promise<{ gatewayUrl: string; sessionKey: string | null }> {
    const body = new URLSearchParams({
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      total_amount: req.amountBdt.toFixed(2),
      currency: 'BDT',
      tran_id: req.tranId,
      success_url: req.urls.success,
      fail_url: req.urls.fail,
      cancel_url: req.urls.cancel,
      ipn_url: req.urls.ipn,
      cus_name: req.customer.name,
      cus_email: req.customer.email,
      cus_phone: req.customer.phone,
      cus_add1: 'Bangladesh',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      num_of_item: '1',
      product_name: req.productName,
      product_category: 'Software',
      product_profile: 'non-physical-goods',
    });
    const res = await this.fetchImpl(`${this.baseUrl}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json || json.status !== 'SUCCESS' || typeof json.GatewayPageURL !== 'string' || !json.GatewayPageURL) {
      const reason = json && typeof json.failedreason === 'string' ? json.failedreason : `HTTP ${res.status}`;
      throw new PaymentProviderError(`SSLCommerz session failed: ${reason}`);
    }
    return { gatewayUrl: json.GatewayPageURL, sessionKey: typeof json.sessionkey === 'string' ? json.sessionkey : null };
  }

  async validate(valId: string): Promise<ValidationResult> {
    const url = new URL(`${this.baseUrl}/validator/api/validationserverAPI.php`);
    url.search = new URLSearchParams({
      val_id: valId,
      store_id: this.config.storeId,
      store_passwd: this.config.storePassword,
      v: '1',
      format: 'json',
    }).toString();
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json) throw new PaymentProviderError(`SSLCommerz validation failed: HTTP ${res.status}`);
    const str = (k: string) => (json[k] == null ? '' : String(json[k]));
    return {
      status: str('status'),
      tranId: str('tran_id'),
      amount: Number(json.amount),
      currency: str('currency') || str('currency_type'),
      riskLevel: str('risk_level'),
      bankTranId: str('bank_tran_id') || null,
      cardType: str('card_type') || null,
      raw: json,
    };
  }
}
