import { ANNUAL_MONTHS_CHARGED, planOf, type PlanId } from './plans.js';

/**
 * Prepaid subscriptions. Bangladeshi wallets (bKash, Nagad) can't be charged automatically, so a
 * seller buys a period up front: monthly = 30 days, annual = 365 days for 10× the monthly price.
 * After the period ends there is a short grace period, then the account falls back to Free.
 */
export const CYCLES = ['monthly', 'annual'] as const;
export type Cycle = (typeof CYCLES)[number];

export const CYCLE_DAYS: Record<Cycle, number> = { monthly: 30, annual: 365 };
export const GRACE_DAYS = 3;
const DAY = 86_400_000;

export type SubscriptionStatus = 'free' | 'comped' | 'active' | 'grace' | 'expired';

export interface SubscriptionFields {
  plan: PlanId;
  planPaidUntil: string | null;
  planDailyRate: number;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  /** The plan whose limits apply right now. */
  effectivePlan: PlanId;
  /** The plan the seller last bought (may differ from effectivePlan once expired). */
  purchasedPlan: PlanId;
  paidUntil: Date | null;
  graceEndsAt: Date | null;
  /** Whole days until paidUntil (negative once past it). */
  daysLeft: number | null;
}

export function subscriptionState(s: SubscriptionFields, now: Date): SubscriptionState {
  const base = { purchasedPlan: s.plan, paidUntil: null, graceEndsAt: null, daysLeft: null };
  if (s.plan === 'free') return { ...base, status: 'free', effectivePlan: 'free' };
  if (!s.planPaidUntil) return { ...base, status: 'comped', effectivePlan: s.plan };

  const paidUntil = new Date(s.planPaidUntil);
  const graceEndsAt = new Date(paidUntil.getTime() + GRACE_DAYS * DAY);
  const daysLeft = Math.ceil((paidUntil.getTime() - now.getTime()) / DAY);
  const common = { purchasedPlan: s.plan, paidUntil, graceEndsAt, daysLeft };
  if (now < paidUntil) return { ...common, status: 'active', effectivePlan: s.plan };
  if (now < graceEndsAt) return { ...common, status: 'grace', effectivePlan: s.plan };
  return { ...common, status: 'expired', effectivePlan: 'free' };
}

export function cyclePriceBdt(plan: PlanId, cycle: Cycle): number {
  const monthly = planOf(plan).priceBdt;
  return cycle === 'annual' ? monthly * ANNUAL_MONTHS_CHARGED : monthly;
}

export function dailyRate(plan: PlanId, cycle: Cycle): number {
  return cyclePriceBdt(plan, cycle) / CYCLE_DAYS[cycle];
}

/** Unused value of the current paid period, credited when the seller switches to a different plan. */
export function prorationCreditBdt(s: SubscriptionFields, targetPlan: PlanId, now: Date): number {
  const state = subscriptionState(s, now);
  if (state.status !== 'active' || targetPlan === s.plan || s.planDailyRate <= 0 || !state.paidUntil) return 0;
  const remainingDays = (state.paidUntil.getTime() - now.getTime()) / DAY;
  return Math.max(0, Math.floor(remainingDays * s.planDailyRate));
}

/**
 * Where a newly paid period ends. Renewing the same plan stacks onto the current period (also during
 * grace, so grace days are not free extra time); anything else starts a fresh period now.
 */
export function nextPaidUntil(s: SubscriptionFields, targetPlan: PlanId, cycle: Cycle, now: Date): Date {
  const state = subscriptionState(s, now);
  const stack = targetPlan === s.plan && (state.status === 'active' || state.status === 'grace') && state.paidUntil;
  const start = stack ? state.paidUntil! : now;
  return new Date(start.getTime() + CYCLE_DAYS[cycle] * DAY);
}

/** Monthly-equivalent revenue of one seller, for MRR. */
export function monthlyRecurringBdt(s: SubscriptionFields & { planCycle: Cycle | null }, now: Date): number {
  const state = subscriptionState(s, now);
  if (state.status !== 'active' || !s.planCycle) return 0;
  return s.planCycle === 'annual' ? Math.round(cyclePriceBdt(s.plan, 'annual') / 12) : cyclePriceBdt(s.plan, 'monthly');
}
