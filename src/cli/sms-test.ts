/**
 * Send test SMS through the configured gateway before going live.
 *
 *   dev:        npm run sms:test -- 01712345678
 *   production: docker compose exec app node dist/cli/sms-test.js 01712345678
 *
 * Sends one English (GSM-7) and one Bangla (Unicode) message, and prints the gateway's raw answer so
 * you can set SMS_HTTP_SUCCESS_PATTERN and check that Bangla arrives readable, not as "????".
 */
import { loadConfig } from '../config.js';
import { normalizeBdPhone } from '../domain/phone.js';
import { buildService } from '../main.js';

const to = normalizeBdPhone(process.argv[2] ?? '');
if (!to) {
  console.error('Usage: sms-test <your mobile number, e.g. 01712345678>');
  process.exit(1);
}

const config = loadConfig();
const { sms, store } = buildService(config);
console.log(`Provider: ${sms.name}${config.sms.provider === 'http' ? ` (${new URL(config.sms.urlTemplate.replace(/\{\w+\}/g, 'x')).host})` : ''}`);

let failed = false;
for (const text of ['Shipnod test: English SMS works.', 'Shipnod পরীক্ষা: বাংলা SMS ঠিকমতো আসছে।']) {
  const result = await sms.send({ to, text });
  failed ||= !result.ok;
  console.log(`${result.ok ? 'OK  ' : 'FAIL'} ${text}\n     gateway: ${result.ok ? result.providerMessageId ?? '' : result.error}`);
}
store.close();
console.log(failed ? '\nAt least one message failed — see docs/07-deployment.md → Troubleshooting.' : '\nSent. Check that both arrive and the Bangla one is readable.');
process.exit(failed ? 1 : 0);
