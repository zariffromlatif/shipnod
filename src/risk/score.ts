import { toBanglaDigits as bn } from '../domain/phone.js';
import type {
  DeliveryHistory,
  RiskAction,
  RiskAssessment,
  RiskLevel,
  RiskReason,
} from '../domain/types.js';

/**
 * Explainable COD risk score (0–100).
 *
 * Deliberately an additive points model, not a black box: sellers must be able to see *why*
 * an order was flagged ("returned 3 of 4 past orders", "5 orders from this number today"),
 * and every point can be traced to a reason. Once enough outcome data exists, the weights
 * here are the first thing to fit against real delivered/returned labels.
 */

export interface RiskPolicy {
  /** Scores at or above this need confirmation. */
  mediumAt: number;
  /** Scores at or above this need an advance (delivery charge) payment. */
  highAt: number;
  /** Scores at or above this are held for manual review. */
  criticalAt: number;
  /** When false, high-risk orders fall back to confirmation instead of advance payment. */
  advancePaymentEnabled: boolean;
}

export const DEFAULT_RISK_POLICY: Readonly<RiskPolicy> = Object.freeze({
  mediumAt: 30,
  highAt: 60,
  criticalAt: 80,
  advancePaymentEnabled: true,
});

export interface RiskInput {
  phoneValid: boolean;
  codAmount: number;
  /** Omit for a bare phone lookup (no address known yet) to skip the address check. */
  address?: string;
  placedAt: Date;
  /** Outcomes for this phone across all sellers (including this seller). */
  network: DeliveryHistory;
  /** Outcomes for this phone with this seller only; weighted extra on top of `network`. */
  seller: DeliveryHistory;
  /** Distinct sellers that recorded a return for this phone. */
  networkReturnSellers: number;
  /** Other orders from this phone, across all sellers, in the last 24 hours. */
  recentOrders24h: number;
  /** Seller's average order value in BDT, if known. */
  sellerAverageOrderValue: number | null;
  blockedBySeller: boolean;
}

export const WEIGHTS = Object.freeze({
  base: 10,
  noHistory: 20,
  /** Prior belief: an unknown COD customer returns ~20% of parcels (assumption; tune with data). */
  priorReturnRate: 0.2,
  priorStrength: 2,
  sellerExtraWeight: 0.5,
  historyPivot: 0.15,
  historySlope: 120,
  historyMin: -20,
  historyMax: 65,
  cancellationEach: 6,
  cancellationMax: 18,
  multiSellerTwo: 15,
  multiSellerThreeOrMore: 25,
  burstThree: 12,
  burstFive: 25,
  highValue: 10,
  highValueUnknownExtra: 5,
  vagueAddress: 10,
  lateNight: 5,
  invalidPhone: 50,
  prepaid: -30,
});

const DHAKA_UTC_OFFSET_HOURS = 6; // Bangladesh has no DST.

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function dhakaHour(date: Date): number {
  return (date.getUTCHours() + DHAKA_UTC_OFFSET_HOURS) % 24;
}

export function isVagueAddress(address: string): boolean {
  const trimmed = address.trim();
  const words = trimmed.split(/[\s,]+/).filter(Boolean);
  return trimmed.length < 15 || words.length < 3;
}

/** Bayesian-smoothed return rate, so one return out of one order isn't treated as 100%. */
export function smoothedReturnRate(network: DeliveryHistory, seller: DeliveryHistory): number {
  const w = WEIGHTS;
  const delivered = network.delivered + w.sellerExtraWeight * seller.delivered;
  const returned = network.returned + w.sellerExtraWeight * seller.returned;
  return (returned + w.priorReturnRate * w.priorStrength) / (delivered + returned + w.priorStrength);
}

export function levelFor(score: number, policy: RiskPolicy): RiskLevel {
  if (score >= policy.criticalAt) return 'critical';
  if (score >= policy.highAt) return 'high';
  if (score >= policy.mediumAt) return 'medium';
  return 'low';
}

export function actionFor(level: RiskLevel, policy: RiskPolicy): RiskAction {
  switch (level) {
    case 'low':
      return 'auto_ship';
    case 'medium':
      return 'confirm';
    case 'high':
      return policy.advancePaymentEnabled ? 'advance_payment' : 'confirm';
    case 'critical':
      return 'hold';
  }
}

export function assessRisk(input: RiskInput, policy: RiskPolicy = DEFAULT_RISK_POLICY): RiskAssessment {
  const w = WEIGHTS;
  const reasons: RiskReason[] = [];
  const add = (code: string, points: number, message: string, messageBn: string) => {
    if (points !== 0) reasons.push({ code, points, message, messageBn });
  };

  const { network } = input;
  const completed = network.delivered + network.returned;
  const deliverySuccessRate = completed > 0 ? network.delivered / completed : null;

  if (input.blockedBySeller) {
    const blocked: RiskReason = {
      code: 'BLOCKED',
      points: 100,
      message: 'You blocked this number',
      messageBn: 'আপনি এই নম্বরটি ব্লক করেছেন',
    };
    return {
      score: 100,
      level: 'critical',
      action: 'hold',
      reasons: [blocked],
      deliverySuccessRate,
      ordersSeen: completed,
    };
  }

  add('BASE', w.base, 'Baseline risk for a cash-on-delivery order', 'ক্যাশ অন ডেলিভারি অর্ডারের সাধারণ ঝুঁকি');

  if (!input.phoneValid) {
    add('INVALID_PHONE', w.invalidPhone, 'Not a valid Bangladeshi mobile number', 'সঠিক বাংলাদেশি মোবাইল নম্বর নয়');
  }

  const sellerCompleted = input.seller.delivered + input.seller.returned;
  if (completed === 0 && sellerCompleted === 0) {
    add('NO_HISTORY', w.noHistory, 'No delivery history for this number yet', 'এই নম্বরে এখনো কোনো ডেলিভারির রেকর্ড নেই');
  } else {
    const rate = smoothedReturnRate(network, input.seller);
    const points = Math.round(clamp((rate - w.historyPivot) * w.historySlope, w.historyMin, w.historyMax));
    if (points < 0) {
      add(
        'GOOD_HISTORY',
        points,
        `Delivered ${network.delivered} of ${completed} past orders`,
        `আগের ${bn(completed)}টি অর্ডারের মধ্যে ${bn(network.delivered)}টি ডেলিভারি হয়েছে`,
      );
    } else {
      add(
        'RETURN_HISTORY',
        points,
        `Returned ${network.returned} of ${completed} past orders`,
        `আগের ${bn(completed)}টি অর্ডারের মধ্যে ${bn(network.returned)}টি ফেরত এসেছে`,
      );
    }
  }

  if (network.cancelled > 0) {
    add(
      'PAST_CANCELLATIONS',
      Math.min(w.cancellationMax, network.cancelled * w.cancellationEach),
      `Cancelled ${network.cancelled} past order(s) before shipping`,
      `আগে ${bn(network.cancelled)}টি অর্ডার বাতিল করেছেন`,
    );
  }

  if (input.networkReturnSellers >= 2) {
    const n = input.networkReturnSellers;
    add(
      'MULTI_SELLER_RETURNS',
      n >= 3 ? w.multiSellerThreeOrMore : w.multiSellerTwo,
      `Returned parcels to ${n} different sellers`,
      `${bn(n)} জন ভিন্ন বিক্রেতার পার্সেল ফেরত দিয়েছেন`,
    );
  }

  if (input.recentOrders24h >= 3) {
    const n = input.recentOrders24h;
    add(
      'ORDER_BURST',
      n >= 5 ? w.burstFive : w.burstThree,
      `${n} other orders from this number in the last 24 hours`,
      `গত ২৪ ঘণ্টায় এই নম্বর থেকে আরও ${bn(n)}টি অর্ডার`,
    );
  }

  if (input.codAmount <= 0) {
    add('PREPAID', w.prepaid, 'Prepaid order — nothing to collect on delivery', 'অগ্রিম পরিশোধিত অর্ডার');
  } else {
    const avg = input.sellerAverageOrderValue;
    const highValueAt = avg && avg > 0 ? Math.max(3 * avg, 2000) : 5000;
    if (input.codAmount >= highValueAt) {
      add(
        'HIGH_VALUE',
        w.highValue + (completed === 0 ? w.highValueUnknownExtra : 0),
        `Order value Tk ${input.codAmount} is unusually high`,
        `অর্ডারের মূল্য ৳${bn(input.codAmount)} স্বাভাবিকের চেয়ে বেশি`,
      );
    }
  }

  if (input.address !== undefined && isVagueAddress(input.address)) {
    add('VAGUE_ADDRESS', w.vagueAddress, 'Address is too short or vague for reliable delivery', 'ঠিকানা অসম্পূর্ণ বা অস্পষ্ট');
  }

  if (dhakaHour(input.placedAt) < 6) {
    add('LATE_NIGHT', w.lateNight, 'Placed between midnight and 6 AM', 'মধ্যরাত থেকে ভোর ৬টার মধ্যে অর্ডার করা হয়েছে');
  }

  const score = clamp(Math.round(reasons.reduce((sum, r) => sum + r.points, 0)), 0, 100);
  const level = levelFor(score, policy);
  return {
    score,
    level,
    action: actionFor(level, policy),
    reasons,
    deliverySuccessRate,
    ordersSeen: completed,
  };
}
