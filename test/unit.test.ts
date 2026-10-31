import { describe, expect, it } from 'vitest';
import { annualPriceBdt, billingPeriod, overageBdt, PLANS } from '../src/billing/plans.js';
import { advancePaymentSms, confirmationSms, smsSegments } from '../src/confirmation/messages.js';
import { HttpTemplateSmsProvider } from '../src/confirmation/sms.js';
import { canTransition, assertTransition, InvalidTransitionError, isTerminal } from '../src/domain/order-state.js';
import { maskPhone, normalizeBdPhone, operatorOf, toBanglaDigits } from '../src/domain/phone.js';
import { hashPhone, randomCode, SecretBox, signBase64Hmac, verifyBase64Hmac } from '../src/lib/crypto.js';
import { loadConfig } from '../src/config.js';

describe('phone', () => {
  it.each([
    ['01712345678', '01712345678'],
    ['+8801712345678', '01712345678'],
    ['8801712345678', '01712345678'],
    ['008801712345678', '01712345678'],
    ['1712345678', '01712345678'],
    ['+880 1712-345678', '01712345678'],
    ['০১৭১২৩৪৫৬৭৮', '01712345678'],
    ['+৮৮০১৯১১২২৩৩৪৪', '01911223344'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBdPhone(input)).toBe(expected);
  });

  it.each(['01212345678', '0171234567', '017123456789', '02-9123456', 'abc', ''])('rejects %s', (input) => {
    expect(normalizeBdPhone(input)).toBeNull();
  });

  it('knows operators and masks', () => {
    expect(operatorOf('01712345678')).toBe('Grameenphone');
    expect(operatorOf('01812345678')).toBe('Robi');
    expect(operatorOf('01512345678')).toBe('Teletalk');
    expect(maskPhone('01712345678')).toBe('017****5678');
    expect(toBanglaDigits(1250)).toBe('১২৫০');
  });
});

describe('order state machine', () => {
  it('allows the happy path', () => {
    for (const [a, b] of [
      ['new', 'awaiting_confirmation'],
      ['awaiting_confirmation', 'confirmed'],
      ['confirmed', 'booked'],
      ['booked', 'in_transit'],
      ['in_transit', 'delivered'],
    ] as const) {
      expect(canTransition(a, b)).toBe(true);
    }
  });

  it('blocks shipping cancelled orders and leaving terminal states', () => {
    expect(canTransition('cancelled', 'booked')).toBe(false);
    expect(canTransition('in_transit', 'cancelled')).toBe(false);
    expect(() => assertTransition('delivered', 'returned')).toThrow(InvalidTransitionError);
    expect(isTerminal('returned')).toBe(true);
    expect(isTerminal('booked')).toBe(false);
  });
});

describe('sms copy', () => {
  it('counts GSM-7 and UCS-2 segments', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toEqual({ encoding: 'GSM-7', segments: 2 });
    expect(smsSegments('[' + 'a'.repeat(159))).toEqual({ encoding: 'GSM-7', segments: 2 });
    expect(smsSegments('অ'.repeat(70))).toEqual({ encoding: 'UCS-2', segments: 1 });
    expect(smsSegments('অ'.repeat(71))).toEqual({ encoding: 'UCS-2', segments: 2 });
  });

  it('builds Bangla, Banglish and English confirmations', () => {
    const link = 'https://n.sh/c/Ab12Cd34';
    const bn = confirmationSms({ shopName: 'Rahim Fashion House Dhanmondi', amount: 1250, link, lang: 'bn' });
    expect(bn.text).toContain('৳১২৫০');
    expect(bn.text).toContain(link);
    expect(bn.text.startsWith('Rahim Fashion House')).toBe(true);
    expect(bn.encoding).toBe('UCS-2');

    const banglish = confirmationSms({ shopName: 'Rahim', amount: 1250, link, lang: 'banglish' });
    expect(banglish).toMatchObject({ encoding: 'GSM-7', segments: 1 });

    const adv = advancePaymentSms({ shopName: 'Rahim', fee: 130, link, lang: 'en' });
    expect(adv.text).toContain('Tk 130');
  });

  it('fills the HTTP gateway template with encoded values', () => {
    const p = new HttpTemplateSmsProvider({
      urlTemplate: 'https://sms.example/api?key={apiKey}&from={senderId}&to={to}&local={toLocal}&msg={text}',
      apiKey: 'k&1',
      senderId: 'SHOP',
      fetch: async () => new Response('ok'),
    });
    const url = new URL(p.buildUrl({ to: '01712345678', text: 'হ্যাঁ & yes' }));
    expect(url.searchParams.get('key')).toBe('k&1');
    expect(url.searchParams.get('to')).toBe('8801712345678');
    expect(url.searchParams.get('local')).toBe('01712345678');
    expect(url.searchParams.get('msg')).toBe('হ্যাঁ & yes');
  });

  it('treats gateway bodies that miss the success pattern as failures', async () => {
    const p = new HttpTemplateSmsProvider({
      urlTemplate: 'https://sms.example/?m={text}',
      apiKey: 'k',
      senderId: 's',
      successPattern: '"response_code":\\s*202',
      fetch: async () => new Response('{"response_code":1007,"error":"balance"}'),
    });
    expect((await p.send({ to: '01712345678', text: 'x' })).ok).toBe(false);
  });
});

describe('crypto', () => {
  it('hashes phones deterministically per secret', () => {
    const a = hashPhone('secret-one', '01712345678');
    expect(a).toHaveLength(64);
    expect(hashPhone('secret-one', '01712345678')).toBe(a);
    expect(hashPhone('secret-two', '01712345678')).not.toBe(a);
  });

  it('verifies base64 HMAC signatures', () => {
    const sig = signBase64Hmac('s3cret', '{"id":1}');
    expect(verifyBase64Hmac('s3cret', '{"id":1}', sig)).toBe(true);
    expect(verifyBase64Hmac('s3cret', '{"id":2}', sig)).toBe(false);
    expect(verifyBase64Hmac('other', '{"id":1}', sig)).toBe(false);
    expect(verifyBase64Hmac('s3cret', '{"id":1}', undefined)).toBe(false);
  });

  it('round-trips sealed secrets and detects tampering', () => {
    const box = new SecretBox('ab'.repeat(32));
    const sealed = box.seal('{"apiKey":"x"}');
    expect(box.open(sealed)).toBe('{"apiKey":"x"}');
    const tampered = Buffer.from(sealed, 'base64');
    const last = tampered.length - 1;
    tampered.writeUInt8(tampered.readUInt8(last) ^ 1, last);
    expect(() => box.open(tampered.toString('base64'))).toThrow();
    expect(() => new SecretBox('abcd')).toThrow();
  });

  it('generates base62 codes', () => {
    expect(randomCode(8)).toMatch(/^[0-9A-Za-z]{8}$/);
  });
});

describe('plans', () => {
  it('matches published pricing', () => {
    expect([PLANS.free.priceBdt, PLANS.starter.priceBdt, PLANS.growth.priceBdt, PLANS.scale.priceBdt]).toEqual([0, 990, 2490, 5990]);
    expect(annualPriceBdt(PLANS.growth)).toBe(24_900);
    expect(overageBdt(PLANS.starter, 600)).toBe(150);
    expect(overageBdt(PLANS.free, 600)).toBe(0);
  });

  it('uses the Dhaka calendar month', () => {
    expect(billingPeriod(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11');
    expect(billingPeriod(new Date('2026-10-31T17:00:00Z'))).toBe('2026-10');
  });
});

describe('config', () => {
  it('uses dev defaults outside production', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.sms.provider).toBe('console');
    expect(c.courierSandbox).toBe(true);
  });

  it('refuses to start production without real secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/NETWORK_HASH_SECRET/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', NETWORK_HASH_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'ab'.repeat(32) }),
    ).toThrow(/SMS_PROVIDER/);
  });
});
