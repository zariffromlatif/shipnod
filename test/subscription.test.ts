import { describe, expect, it } from 'vitest';
import {
  cyclePriceBdt,
  dailyRate,
  monthlyRecurringBdt,
  nextPaidUntil,
  prorationCreditBdt,
  subscriptionState,
} from '../src/billing/subscription.js';

const NOW = new Date('2026-11-10T08:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

describe('subscription state', () => {
  it('distinguishes free, comped, active, grace and expired', () => {
    expect(subscriptionState({ plan: 'free', planPaidUntil: null, planDailyRate: 0 }, NOW).status).toBe('free');
    expect(subscriptionState({ plan: 'growth', planPaidUntil: null, planDailyRate: 0 }, NOW)).toMatchObject({ status: 'comped', effectivePlan: 'growth' });

    const active = subscriptionState({ plan: 'growth', planPaidUntil: days(4.5), planDailyRate: 83 }, NOW);
    expect(active).toMatchObject({ status: 'active', effectivePlan: 'growth', daysLeft: 5 });

    const grace = subscriptionState({ plan: 'growth', planPaidUntil: days(-2), planDailyRate: 83 }, NOW);
    expect(grace).toMatchObject({ status: 'grace', effectivePlan: 'growth', daysLeft: -2 });

    const expired = subscriptionState({ plan: 'growth', planPaidUntil: days(-3.1), planDailyRate: 83 }, NOW);
    expect(expired).toMatchObject({ status: 'expired', effectivePlan: 'free', purchasedPlan: 'growth' });
  });
});

describe('prices and credit', () => {
  it('charges 10 months for a year', () => {
    expect(cyclePriceBdt('growth', 'monthly')).toBe(2490);
    expect(cyclePriceBdt('growth', 'annual')).toBe(24_900);
    expect(dailyRate('starter', 'monthly')).toBe(33);
  });

  it('credits the unused part of the current plan only when switching plans', () => {
    const starter = { plan: 'starter' as const, planPaidUntil: days(20), planDailyRate: dailyRate('starter', 'monthly') };
    expect(prorationCreditBdt(starter, 'growth', NOW)).toBe(660);
    expect(prorationCreditBdt(starter, 'starter', NOW)).toBe(0); // renewal: no credit, it stacks instead
    expect(prorationCreditBdt({ ...starter, planPaidUntil: days(-1) }, 'growth', NOW)).toBe(0); // grace: nothing left
    expect(prorationCreditBdt({ plan: 'growth', planPaidUntil: days(20), planDailyRate: 0 }, 'scale', NOW)).toBe(0); // comped pilot
  });

  it('stacks renewals of the same plan and starts fresh otherwise', () => {
    const growth = { plan: 'growth' as const, planPaidUntil: days(10), planDailyRate: 83 };
    expect(nextPaidUntil(growth, 'growth', 'monthly', NOW).toISOString()).toBe(days(40));
    expect(nextPaidUntil(growth, 'scale', 'monthly', NOW).toISOString()).toBe(days(30));
    // During grace, renewal continues from the old end date — grace days are not free time.
    expect(nextPaidUntil({ ...growth, planPaidUntil: days(-2) }, 'growth', 'monthly', NOW).toISOString()).toBe(days(28));
    // Long expired: from now.
    expect(nextPaidUntil({ ...growth, planPaidUntil: days(-30) }, 'growth', 'annual', NOW).toISOString()).toBe(days(365));
  });

  it('counts monthly-equivalent revenue', () => {
    expect(monthlyRecurringBdt({ plan: 'growth', planPaidUntil: days(5), planDailyRate: 83, planCycle: 'monthly' }, NOW)).toBe(2490);
    expect(monthlyRecurringBdt({ plan: 'growth', planPaidUntil: days(5), planDailyRate: 68, planCycle: 'annual' }, NOW)).toBe(2075);
    expect(monthlyRecurringBdt({ plan: 'growth', planPaidUntil: null, planDailyRate: 0, planCycle: null }, NOW)).toBe(0);
    expect(monthlyRecurringBdt({ plan: 'growth', planPaidUntil: days(-1), planDailyRate: 83, planCycle: 'monthly' }, NOW)).toBe(0);
  });
});
