import type { AppConfig } from './config.js';
import { ConsoleSmsProvider, HttpTemplateSmsProvider, type SmsProvider } from './confirmation/sms.js';
import { Store } from './db/store.js';
import { SecretBox } from './lib/crypto.js';
import { SslCommerzClient } from './billing/sslcommerz.js';
import { BillingRepo } from './db/billing-repo.js';
import { AuthService } from './services/auth.js';
import { BillingService } from './services/billing.js';
import { OnboardingService } from './services/onboarding.js';
import { ShipnodService } from './services/shipnod.js';

/** Wires the object graph from config. Shared by the server and CLI scripts. */
export function buildService(config: AppConfig, overrides: { sms?: SmsProvider; fetch?: typeof fetch; store?: Store } = {}) {
  const store = overrides.store ?? new Store(config.databasePath);
  const sms =
    overrides.sms ??
    (config.sms.provider === 'http'
      ? new HttpTemplateSmsProvider({
          urlTemplate: config.sms.urlTemplate,
          apiKey: config.sms.apiKey,
          senderId: config.sms.senderId,
          successPattern: config.sms.successPattern,
        })
      : new ConsoleSmsProvider());
  const service = new ShipnodService({
    store,
    sms,
    secretBox: new SecretBox(config.encryptionKeyHex),
    networkHashSecret: config.networkHashSecret,
    publicBaseUrl: config.publicBaseUrl,
    confirmTtlHours: config.confirmTtlHours,
    courierSandbox: config.courierSandbox,
    fetch: overrides.fetch,
  });
  const auth = new AuthService({ store, sms, service });
  const billingRepo = new BillingRepo(store.db);
  const billing = new BillingService({
    store,
    repo: billingRepo,
    sms,
    publicBaseUrl: config.publicBaseUrl,
    sslcommerz: config.billing.sslcommerz ? new SslCommerzClient({ ...config.billing.sslcommerz, fetch: overrides.fetch }) : null,
    manual: { bkash: config.billing.bkashNumber, nagad: config.billing.nagadNumber },
  });
  const onboarding = new OnboardingService({ service, billing, sms, publicBaseUrl: config.publicBaseUrl });
  return { store, sms, service, auth, billing, billingRepo, onboarding };
}
