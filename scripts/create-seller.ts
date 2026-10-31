/**
 * Onboard a seller and print their API key (shown once) and webhook details.
 *
 *   npm run seller:create -- --name "Rahim" --shop "Rahim Fashion" --plan growth --phone 01712345678
 */
import { parseArgs } from 'node:util';
import { isPlanId } from '../src/billing/plans.js';
import { loadConfig } from '../src/config.js';
import { buildService } from '../src/main.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    shop: { type: 'string' },
    plan: { type: 'string', default: 'free' },
    phone: { type: 'string' },
    lang: { type: 'string', default: 'bn' },
    'trial-days': { type: 'string' },
  },
});

if (!values.name || !values.shop) {
  console.error('Usage: npm run seller:create -- --name "Owner name" --shop "Shop name" [--plan free|starter|growth|scale] [--trial-days 14] [--phone 01...] [--lang bn|banglish|en]');
  process.exit(1);
}
if (!isPlanId(values.plan!)) {
  console.error(`Unknown plan "${values.plan}"`);
  process.exit(1);
}
const lang = values.lang as 'bn' | 'banglish' | 'en';
if (!['bn', 'banglish', 'en'].includes(lang)) {
  console.error(`Unknown language "${values.lang}"`);
  process.exit(1);
}

const config = loadConfig();
const { service, store, billing } = buildService(config);
const { seller, apiKey } = service.createSeller({
  name: values.name,
  shopName: values.shop,
  plan: values.plan,
  phone: values.phone,
  smsLang: lang,
});
const trialDays = values['trial-days'] ? Number(values['trial-days']) : null;
if (trialDays !== null) {
  if (!Number.isInteger(trialDays) || trialDays < 1 || values.plan === 'free') {
    console.error('--trial-days needs a positive whole number and a paid --plan');
    process.exit(1);
  }
  billing.grantPlan(seller.id, values.plan as 'starter' | 'growth' | 'scale', trialDays);
}
store.close();

console.log(`
Seller created: ${seller.id} (${seller.shopName}, plan: ${seller.plan}${trialDays ? `, ${trialDays}-day pilot — then they pay at /app/billing` : seller.plan === 'free' ? '' : ', no expiry'})

API key (store it now — it is not shown again):
  ${apiKey}

Webhook secret (paste into WooCommerce / Shopify webhook settings):
  ${seller.webhookSecret}

Webhook URLs:
  WooCommerce (topic "Order created"): ${config.publicBaseUrl}/webhooks/woocommerce/${seller.id}
  Shopify     (orders/create):         ${config.publicBaseUrl}/webhooks/shopify/${seller.id}
`);
