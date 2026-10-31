import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { SmsProvider } from '../confirmation/sms.js';
import type { Seller, Store } from '../db/store.js';
import { normalizeBdPhone } from '../domain/phone.js';
import { sha256Hex } from '../lib/crypto.js';
import type { ShipnodService } from './shipnod.js';

/**
 * Dashboard login. Sellers sign in with their phone number and a 6-digit SMS code — the same
 * flow they know from bKash and every bank app — so there are no passwords to forget or reuse.
 * An API-key login exists as a fallback (support, sellers without a registered phone).
 */
export const SESSION_TTL_DAYS = 30;
export const LOGIN_CODE_TTL_MINUTES = 10;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_RESEND_SECONDS = 60;
export const LOGIN_CODES_PER_HOUR = 5;

export type RequestCodeResult =
  | { status: 'sent'; phone: string }
  /** Unknown number: callers show the same screen as 'sent' so registered numbers can't be enumerated. */
  | { status: 'unknown'; phone: string }
  | { status: 'invalid_phone' }
  | { status: 'rate_limited'; phone: string; retryAfterSeconds: number };

export type VerifyCodeResult =
  | { status: 'ok'; token: string; seller: Seller }
  | { status: 'invalid' | 'expired' | 'too_many_attempts' };

export interface AuthDeps {
  store: Store;
  sms: SmsProvider;
  service: ShipnodService;
  now?: () => Date;
}

function codeHash(sellerId: string, code: string): string {
  return sha256Hex(`login:${sellerId}:${code}`);
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AuthService {
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(private readonly deps: AuthDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  async requestLoginCode(phoneInput: string): Promise<RequestCodeResult> {
    const phone = normalizeBdPhone(phoneInput);
    if (!phone) return { status: 'invalid_phone' };
    const seller = this.store.getSellerByPhone(phone);
    if (!seller) return { status: 'unknown', phone };

    const now = this.now();
    const latest = this.store.latestLoginCode(seller.id);
    if (latest) {
      const elapsed = (now.getTime() - new Date(latest.createdAt).getTime()) / 1000;
      if (elapsed < LOGIN_CODE_RESEND_SECONDS) {
        return { status: 'rate_limited', phone, retryAfterSeconds: Math.ceil(LOGIN_CODE_RESEND_SECONDS - elapsed) };
      }
    }
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    if (this.store.countLoginCodesSince(seller.id, hourAgo) >= LOGIN_CODES_PER_HOUR) {
      return { status: 'rate_limited', phone, retryAfterSeconds: 3600 };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.store.createLoginCode({
      sellerId: seller.id,
      codeHash: codeHash(seller.id, code),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MINUTES * 60_000).toISOString(),
    });
    // GSM-7 text: one SMS part, and readable on every handset.
    await this.deps.sms.send({
      to: phone,
      text: `Your Shipnod login code is ${code}. It expires in ${LOGIN_CODE_TTL_MINUTES} minutes. Never share it.`,
    });
    return { status: 'sent', phone };
  }

  verifyLoginCode(phoneInput: string, codeInput: string): VerifyCodeResult {
    const phone = normalizeBdPhone(phoneInput);
    const code = codeInput.replace(/\D/g, '');
    const seller = phone ? this.store.getSellerByPhone(phone) : null;
    if (!seller || code.length !== 6) return { status: 'invalid' };

    const latest = this.store.latestLoginCode(seller.id);
    if (!latest || latest.usedAt) return { status: 'invalid' };
    if (latest.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return { status: 'too_many_attempts' };
    if (new Date(latest.expiresAt) <= this.now()) return { status: 'expired' };
    if (!safeEqualHex(latest.codeHash, codeHash(seller.id, code))) {
      this.store.recordLoginAttempt(latest.id);
      return latest.attempts + 1 >= LOGIN_CODE_MAX_ATTEMPTS ? { status: 'too_many_attempts' } : { status: 'invalid' };
    }
    this.store.markLoginCodeUsed(latest.id, this.now().toISOString());
    return { status: 'ok', token: this.createSession(seller.id), seller };
  }

  loginWithApiKey(apiKey: string): { token: string; seller: Seller } | null {
    const seller = this.deps.service.authenticate(apiKey.trim());
    return seller ? { token: this.createSession(seller.id), seller } : null;
  }

  createSession(sellerId: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    this.store.createSession(
      sha256Hex(token),
      sellerId,
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_DAYS * 86400_000).toISOString(),
    );
    return token;
  }

  sessionSeller(token: string | undefined): Seller | null {
    if (!token) return null;
    const sellerId = this.store.getSessionSellerId(sha256Hex(token), this.now().toISOString());
    return sellerId ? this.store.getSeller(sellerId) : null;
  }

  logout(token: string | undefined): void {
    if (token) this.store.deleteSession(sha256Hex(token));
  }

  /** Per-session CSRF token: derived from the secret session token, so it needs no storage. */
  csrfToken(sessionToken: string): string {
    return sha256Hex(`csrf:${sessionToken}`).slice(0, 32);
  }

  verifyCsrf(sessionToken: string, given: unknown): boolean {
    if (typeof given !== 'string' || given.length !== 32 || !/^[0-9a-f]+$/.test(given)) return false;
    return safeEqualHex(this.csrfToken(sessionToken), given);
  }
}
