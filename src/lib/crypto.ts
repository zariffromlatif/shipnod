import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Uniformly random base62 string (no modulo bias). */
export function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomCode(16)}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Phone numbers in the shared network are stored only as HMAC-SHA256 digests keyed with a
 * server secret, so the table can't be reversed with a simple dictionary of all ~10^9 BD numbers.
 */
export function hashPhone(secret: string, normalizedPhone: string): string {
  return createHmac('sha256', secret).update(`phone:${normalizedPhone}`).digest('hex');
}

/** Constant-time check of a base64 HMAC-SHA256 signature over a raw body (WooCommerce, Shopify). */
export function verifyBase64Hmac(secret: string, rawBody: string, signature: string | undefined | null): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBase64Hmac(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** AES-256-GCM for courier credentials at rest. Output: base64(iv | tag | ciphertext). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
    this.key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  open(sealed: string): string {
    const buf = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  }
}
