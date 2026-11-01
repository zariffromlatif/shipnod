/**
 * Sign up a seller from the command line (the admin console's "+ নতুন বিক্রেতা" does the same).
 *
 *   dev:        npm run seller:create -- --name "Rahim" --shop "Rahim Fashion" --phone 01712345678 --plan growth --trial-days 14 --welcome
 *   production: docker compose exec app node dist/cli/create-seller.js --name "Rahim" --shop "Rahim Fashion" --phone 01712345678 --plan growth --trial-days 14 --welcome
 */
import { parseArgs } from 'node:util';
import { isPlanId } from '../billing/plans.js';
import { loadConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { buildService } from '../main.js';

const USAGE =
  'Usage: create-seller --name "Owner name" --shop "Shop name" --phone 01XXXXXXXXX [--plan free|starter|growth|scale] [--trial-days 14] [--lang bn|banglish|en] [--welcome]';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    shop: { type: 'string' },
    phone: { type: 'string' },
    plan: { type: 'string', default: 'free' },
    lang: { type: 'string', default: 'bn' },
    'trial-days': { type: 'string' },
    welcome: { type: 'boolean', default: false },
  },
});

if (!values.name || !values.shop || !values.phone) {
  console.error(USAGE);
  process.exit(1);
}
if (!isPlanId(values.plan!)) {
  console.error(`Unknown plan "${values.plan}"\n${USAGE}`);
  process.exit(1);
}
const lang = values.lang as 'bn' | 'banglish' | 'en';
if (!['bn', 'banglish', 'en'].includes(lang)) {
  console.error(`Unknown language "${values.lang}"\n${USAGE}`);
  process.exit(1);
}
const trialDays = values['trial-days'] ? Number(values['trial-days']) : null;
if (trialDays !== null && values.plan === 'free') {
  console.error('--trial-days needs a paid --plan');
  process.exit(1);
}

const config = loadConfig();
const { onboarding, store } = buildService(config);
try {
  const r = await onboarding.onboard({
    name: values.name,
    shopName: values.shop,
    phone: values.phone,
    plan: values.plan,
    trialDays,
    smsLang: lang,
    sendWelcome: values.welcome!,
  });
  const s = r.seller;
  console.log(`
Seller created: ${s.id} (${s.shopName}, ${s.phone}, plan: ${s.plan}${s.planPaidUntil ? `, pilot until ${s.planPaidUntil.slice(0, 10)} — then they pay at /app/billing` : s.plan === 'free' ? '' : ', no expiry'})

Login link (they sign in with ${s.phone} and an SMS code):
  ${r.loginUrl}
${values.welcome ? (r.welcome.sent ? '  ✓ texted to the seller\n' : `  ✗ SMS failed: ${r.welcome.error}\n`) : ''}
API key (only for their own systems / API — store it now, it is not shown again):
  ${r.apiKey}

Webhook secret and URLs for WooCommerce / Shopify:
  ${s.webhookSecret}
  ${config.publicBaseUrl}/webhooks/woocommerce/${s.id}   (topic "Order created")
  ${config.publicBaseUrl}/webhooks/shopify/${s.id}       (orders/create)
`);
} catch (err) {
  if (err instanceof AppError) {
    console.error(`Could not create seller: ${err.message}`);
    process.exitCode = 1;
  } else throw err;
} finally {
  store.close();
}
