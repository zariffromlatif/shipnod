/**
 * Plans and limits. Prices in BDT per month. Keep in sync with docs/02-business-plan.md.
 * Annual prepay = 10x monthly (2 months free). Paid plans may exceed `monthlyOrders`; the excess
 * is billed at OVERAGE_BDT_PER_ORDER. Free is hard-capped.
 */
export const PLAN_IDS = ['free', 'starter', 'growth', 'scale'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  priceBdt: number;
  /** Orders processed through the automation pipeline per month. */
  monthlyOrders: number;
  /** Manual "check this customer" lookups per month. */
  monthlyRiskChecks: number;
  /** How many courier accounts can be connected. */
  maxCouriers: number;
  /** WooCommerce / Shopify webhooks. */
  storeIntegrations: boolean;
  /** Seller-defined risk thresholds and advance-payment rules. */
  customRiskRules: boolean;
  voiceConfirmation: boolean;
  multiUser: boolean;
}

export const OVERAGE_BDT_PER_ORDER = 1.5;
export const ANNUAL_MONTHS_CHARGED = 10;

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    priceBdt: 0,
    monthlyOrders: 0,
    monthlyRiskChecks: 100,
    maxCouriers: 0,
    storeIntegrations: false,
    customRiskRules: false,
    voiceConfirmation: false,
    multiUser: false,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceBdt: 990,
    monthlyOrders: 500,
    monthlyRiskChecks: 1_000,
    maxCouriers: 1,
    storeIntegrations: false,
    customRiskRules: false,
    voiceConfirmation: false,
    multiUser: false,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceBdt: 2_490,
    monthlyOrders: 2_000,
    monthlyRiskChecks: 5_000,
    maxCouriers: 3,
    storeIntegrations: true,
    customRiskRules: true,
    voiceConfirmation: false,
    multiUser: false,
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceBdt: 5_990,
    monthlyOrders: 6_000,
    monthlyRiskChecks: 20_000,
    maxCouriers: 3,
    storeIntegrations: true,
    customRiskRules: true,
    voiceConfirmation: true,
    multiUser: true,
  },
});

export function planOf(id: string): Plan {
  return (PLANS as Record<string, Plan>)[id] ?? PLANS.free;
}

export function isPlanId(id: string): id is PlanId {
  return (PLAN_IDS as readonly string[]).includes(id);
}

/** "YYYY-MM" in Asia/Dhaka (UTC+6), the billing period key. */
export function billingPeriod(date: Date = new Date()): string {
  const dhaka = new Date(date.getTime() + 6 * 3600_000);
  return `${dhaka.getUTCFullYear()}-${String(dhaka.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function overageBdt(plan: Plan, ordersThisPeriod: number): number {
  if (plan.id === 'free') return 0;
  return Math.max(0, ordersThisPeriod - plan.monthlyOrders) * OVERAGE_BDT_PER_ORDER;
}

export function annualPriceBdt(plan: Plan): number {
  return plan.priceBdt * ANNUAL_MONTHS_CHARGED;
}
