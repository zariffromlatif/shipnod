import { z } from 'zod';

const DEV_NETWORK_SECRET = 'dev-only-network-secret-do-not-use-in-production';
const DEV_ENCRYPTION_KEY = '0'.repeat(64);

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined || ['1', 'true', 'yes'].includes(v.toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  DATABASE_PATH: z.string().default('./data/shipnod.db'),
  NETWORK_HASH_SECRET: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
  SMS_HTTP_URL: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  SMS_HTTP_SUCCESS_PATTERN: z.string().optional(),
  COURIER_SANDBOX: bool,
  STATUS_SYNC_INTERVAL_MINUTES: z.coerce.number().min(0).default(30),
  CONFIRM_TTL_HOURS: z.coerce.number().positive().default(48),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  networkHashSecret: string;
  encryptionKeyHex: string;
  sms:
    | { provider: 'console' }
    | { provider: 'http'; urlTemplate: string; apiKey: string; senderId: string; successPattern?: string };
  courierSandbox: boolean;
  statusSyncIntervalMinutes: number;
  confirmTtlHours: number;
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const e = envSchema.parse(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, blank(v)])));
  const prod = e.NODE_ENV === 'production';

  const networkHashSecret = e.NETWORK_HASH_SECRET ?? (prod ? undefined : DEV_NETWORK_SECRET);
  const encryptionKeyHex = e.APP_ENCRYPTION_KEY ?? (prod ? undefined : DEV_ENCRYPTION_KEY);
  if (!networkHashSecret || networkHashSecret.length < 32) {
    throw new Error('NETWORK_HASH_SECRET must be set (>= 32 chars) in production. Generate: openssl rand -hex 32');
  }
  if (!encryptionKeyHex || !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    throw new Error('APP_ENCRYPTION_KEY must be 64 hex chars. Generate: openssl rand -hex 32');
  }
  if (prod && (networkHashSecret === DEV_NETWORK_SECRET || encryptionKeyHex === DEV_ENCRYPTION_KEY)) {
    throw new Error('Refusing to start in production with development secrets');
  }

  let sms: AppConfig['sms'] = { provider: 'console' };
  if (e.SMS_PROVIDER === 'http') {
    if (!e.SMS_HTTP_URL || !e.SMS_API_KEY || !e.SMS_SENDER_ID) {
      throw new Error('SMS_PROVIDER=http needs SMS_HTTP_URL, SMS_API_KEY and SMS_SENDER_ID');
    }
    sms = {
      provider: 'http',
      urlTemplate: e.SMS_HTTP_URL,
      apiKey: e.SMS_API_KEY,
      senderId: e.SMS_SENDER_ID,
      successPattern: e.SMS_HTTP_SUCCESS_PATTERN,
    };
  } else if (prod) {
    throw new Error('SMS_PROVIDER=console is not allowed in production');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    databasePath: e.DATABASE_PATH,
    networkHashSecret,
    encryptionKeyHex,
    sms,
    courierSandbox: e.COURIER_SANDBOX,
    statusSyncIntervalMinutes: e.STATUS_SYNC_INTERVAL_MINUTES,
    confirmTtlHours: e.CONFIRM_TTL_HOURS,
  };
}
