import { describe, expect, it } from 'vitest';
import { assessRisk, DEFAULT_RISK_POLICY, dhakaHour, isVagueAddress, type RiskInput } from '../src/risk/score.js';

const none = { delivered: 0, returned: 0, cancelled: 0 };
const ADDRESS = 'House 12, Road 5, Dhanmondi, Dhaka';
const AFTERNOON = new Date('2026-10-31T08:00:00Z'); // 14:00 in Dhaka

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    phoneValid: true,
    codAmount: 1200,
    address: ADDRESS,
    placedAt: AFTERNOON,
    network: none,
    seller: none,
    networkReturnSellers: 0,
    recentOrders24h: 0,
    sellerAverageOrderValue: 1100,
    blockedBySeller: false,
    ...overrides,
  };
}

const codes = (r: ReturnType<typeof assessRisk>) => r.reasons.map((x) => x.code);

describe('assessRisk', () => {
  it('asks unknown customers to confirm', () => {
    const r = assessRisk(input());
    expect(r).toMatchObject({ score: 30, level: 'medium', action: 'confirm', deliverySuccessRate: null, ordersSeen: 0 });
    expect(codes(r)).toEqual(['BASE', 'NO_HISTORY']);
  });

  it('auto-ships customers with a clean record', () => {
    const r = assessRisk(input({ network: { delivered: 5, returned: 0, cancelled: 0 } }));
    expect(r.level).toBe('low');
    expect(r.action).toBe('auto_ship');
    expect(r.deliverySuccessRate).toBe(1);
    expect(codes(r)).toContain('GOOD_HISTORY');
  });

  it('asks serial returners for an advance', () => {
    const r = assessRisk(input({ network: { delivered: 0, returned: 2, cancelled: 0 } }));
    expect(r.score).toBe(64);
    expect(r).toMatchObject({ level: 'high', action: 'advance_payment', deliverySuccessRate: 0 });
  });

  it('holds numbers that returned parcels to many sellers', () => {
    const r = assessRisk(
      input({ network: { delivered: 0, returned: 4, cancelled: 0 }, networkReturnSellers: 3 }),
    );
    expect(r).toMatchObject({ level: 'critical', action: 'hold' });
    expect(codes(r)).toContain('MULTI_SELLER_RETURNS');
  });

  it('weights the seller own history on top of the network', () => {
    const networkOnly = assessRisk(input({ network: { delivered: 1, returned: 1, cancelled: 0 } }));
    const ownReturn = assessRisk(
      input({ network: { delivered: 1, returned: 1, cancelled: 0 }, seller: { delivered: 0, returned: 1, cancelled: 0 } }),
    );
    expect(ownReturn.score).toBeGreaterThan(networkOnly.score);
  });

  it('flags order bursts, vague addresses, late-night and high-value orders', () => {
    const r = assessRisk(
      input({
        recentOrders24h: 5,
        address: 'Mirpur',
        placedAt: new Date('2026-10-30T20:30:00Z'), // 02:30 in Dhaka
        codAmount: 9000,
      }),
    );
    expect(codes(r)).toEqual(expect.arrayContaining(['ORDER_BURST', 'VAGUE_ADDRESS', 'LATE_NIGHT', 'HIGH_VALUE']));
    expect(r.level).toBe('critical');
  });

  it('treats only-cancellations as worse than unknown', () => {
    const unknown = assessRisk(input());
    const cancelled = assessRisk(input({ network: { delivered: 0, returned: 0, cancelled: 1 } }));
    expect(cancelled.score).toBeGreaterThan(unknown.score);
  });

  it('lets prepaid orders ship', () => {
    expect(assessRisk(input({ codAmount: 0 })).action).toBe('auto_ship');
  });

  it('holds invalid phones and blocked numbers', () => {
    expect(assessRisk(input({ phoneValid: false })).action).toBe('hold');
    const blocked = assessRisk(input({ blockedBySeller: true, network: { delivered: 9, returned: 0, cancelled: 0 } }));
    expect(blocked).toMatchObject({ score: 100, action: 'hold' });
  });

  it('skips the address check for bare phone lookups', () => {
    expect(codes(assessRisk(input({ address: undefined })))).not.toContain('VAGUE_ADDRESS');
  });

  it('respects custom policies', () => {
    const lenient = { ...DEFAULT_RISK_POLICY, mediumAt: 40, advancePaymentEnabled: false };
    expect(assessRisk(input(), lenient).action).toBe('auto_ship');
    expect(assessRisk(input({ network: { delivered: 0, returned: 2, cancelled: 0 } }), lenient).action).toBe('confirm');
  });

  it('always explains the score', () => {
    const r = assessRisk(input({ network: { delivered: 3, returned: 1, cancelled: 2 }, recentOrders24h: 3 }));
    expect(r.reasons.reduce((s, x) => s + x.points, 0)).toBe(r.score);
    for (const reason of r.reasons) expect(reason.messageBn.length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('converts to Dhaka time', () => {
    expect(dhakaHour(new Date('2026-10-31T18:30:00Z'))).toBe(0);
    expect(dhakaHour(new Date('2026-10-31T08:00:00Z'))).toBe(14);
  });

  it('detects vague addresses', () => {
    expect(isVagueAddress('Mirpur')).toBe(true);
    expect(isVagueAddress('Dhaka, Uttara')).toBe(true);
    expect(isVagueAddress(ADDRESS)).toBe(false);
    expect(isVagueAddress('বাড়ি ১২, রোড ৫, ধানমন্ডি, ঢাকা')).toBe(false);
  });
});
