import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { buildService } from './main.js';

const config = loadConfig();
const { store, service, auth } = buildService(config);
const app = createApp(service, auth, {
  publicBaseUrl: config.publicBaseUrl,
  secureCookies: config.nodeEnv === 'production',
});

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

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  if (syncTimer) clearInterval(syncTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
