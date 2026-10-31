import type { AppConfig } from './config.js';
import { ConsoleSmsProvider, HttpTemplateSmsProvider, type SmsProvider } from './confirmation/sms.js';
import { Store } from './db/store.js';
import { SecretBox } from './lib/crypto.js';
import { NishchitService } from './services/nishchit.js';

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
  const service = new NishchitService({
    store,
    sms,
    secretBox: new SecretBox(config.encryptionKeyHex),
    networkHashSecret: config.networkHashSecret,
    publicBaseUrl: config.publicBaseUrl,
    confirmTtlHours: config.confirmTtlHours,
    courierSandbox: config.courierSandbox,
    fetch: overrides.fetch,
  });
  return { store, sms, service };
}
