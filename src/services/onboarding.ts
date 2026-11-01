import type { PlanId } from '../billing/plans.js';
import { welcomeSms, type SmsLanguage } from '../confirmation/messages.js';
import type { SmsProvider } from '../confirmation/sms.js';
import type { Seller } from '../db/store.js';
import { normalizeBdPhone } from '../domain/phone.js';
import { AppError } from '../lib/errors.js';
import type { BillingService } from './billing.js';
import type { ShipnodService } from './shipnod.js';

export interface OnboardInput {
  name: string;
  shopName: string;
  phone: string;
  plan: PlanId;
  /** Pilot length; null = no expiry (comped). Ignored for the Free plan. */
  trialDays: number | null;
  smsLang: SmsLanguage;
  /** Text the seller their login link right away. */
  sendWelcome: boolean;
}

export interface OnboardResult {
  seller: Seller;
  /** Shown once; only its hash is stored. */
  apiKey: string;
  loginUrl: string;
  welcome: { text: string; sent: boolean; error?: string };
}

/**
 * Signing up a seller: create the account, start the pilot, text them the login link.
 * Used by the admin console ("নতুন বিক্রেতা") and the create-seller CLI, so both behave the same.
 */
export class OnboardingService {
  constructor(
    private readonly deps: { service: ShipnodService; billing: BillingService; sms: SmsProvider; publicBaseUrl: string },
  ) {}

  async onboard(input: OnboardInput): Promise<OnboardResult> {
    const name = input.name.trim();
    const shopName = input.shopName.trim();
    if (!name || name.length > 80) throw new AppError(400, 'invalid_name', 'Owner name is required (max 80 characters)');
    if (!shopName || shopName.length > 60) throw new AppError(400, 'invalid_shop', 'Shop name is required (max 60 characters)');
    const phone = normalizeBdPhone(input.phone);
    if (!phone) throw new AppError(400, 'invalid_phone', 'Not a valid Bangladeshi mobile number');
    if (this.deps.service.findSellerByPhone(phone)) {
      throw new AppError(409, 'phone_taken', 'A seller with this phone number already exists');
    }
    if (input.trialDays !== null && (!Number.isInteger(input.trialDays) || input.trialDays < 1 || input.trialDays > 365)) {
      throw new AppError(400, 'invalid_days', 'Pilot days must be a whole number from 1 to 365');
    }

    const { seller, apiKey } = this.deps.service.createSeller({ name, shopName, phone, plan: input.plan, smsLang: input.smsLang });
    const final =
      input.plan !== 'free' && input.trialDays !== null ? this.deps.billing.grantPlan(seller.id, input.plan, input.trialDays) : seller;

    const loginUrl = `${this.deps.publicBaseUrl}/app/login`;
    const text = welcomeSms({ shopName, link: loginUrl, lang: input.smsLang }).text;
    let welcome: OnboardResult['welcome'] = { text, sent: false };
    if (input.sendWelcome) {
      const result = await this.deps.sms.send({ to: phone, text });
      welcome = { text, sent: result.ok, error: result.ok ? undefined : result.error };
    }
    return { seller: final, apiKey, loginUrl, welcome };
  }
}
