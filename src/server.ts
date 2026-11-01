import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { buildService } from './main.js';

const config = loadConfig();
const { store, service, auth, billing, billingRepo, onboarding } = buildService(config);
const app = createApp(
  { service, auth, billing, billingRepo, onboarding },
  {
    publicBaseUrl: config.publicBaseUrl,
    secureCookies: config.nodeEnv === 'production',
    adminPassword: config.adminPassword,
  },
);
if (!config.adminPassword) console.log('Admin console disabled (set ADMIN_PASSWORD to enable /admin)');

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Shipnod listening on http://localhost:${info.port} (${config.nodeEnv}, sms=${config.sms.provider})`);
});

let syncTimer: NodeJS.Timeout | undefined;
let syncing = false;
if (config.statusSyncIntervalMinutes > 0) {
  syncTimer = setInterval(async () => {
    if (syncing) return;
    syncing = true;
    try {
      const r = await service.syncShippedOrders();
      if (r.checked > 0) console.log(`[sync] checked=${r.checked} updated=${r.updated} errors=${r.errors}`);
    } finally {
      syncing = false;
    }
  }, config.statusSyncIntervalMinutes * 60_000);
}

// Renewal reminders: hourly is plenty; each reminder stage is sent at most once per paid period.
const reminderTimer = setInterval(() => {
  billing.runReminders().then(
    (n) => n > 0 && console.log(`[billing] sent ${n} renewal reminder(s)`),
    (err) => console.error('[billing] reminders failed:', err),
  );
}, 3600_000);

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  if (syncTimer) clearInterval(syncTimer);
  clearInterval(reminderTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
