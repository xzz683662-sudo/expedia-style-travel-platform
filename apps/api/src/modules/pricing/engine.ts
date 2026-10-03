import { PriceRuleKind } from '@prisma/client';
import { config } from '../../config/env';
import { differenceInDays, dayOfWeek } from '../../utils/date';
import { applyBps, BPS_DENOMINATOR } from '../../utils/money';

/**
 * ---------------------------------------------------------------------------
 * Pricing engine
 * ---------------------------------------------------------------------------
 *
 * A quote is computed from the ticket type's base price by folding through
 * every matching `PriceRule` in priority order. Each rule is a small pure
 * function of (context, conditions, adjustment), which keeps the whole engine
 * unit-testable and makes the applied trace auditable.
 *
 * Two adjustments can stack: rules that lower the price (discounts) compose
 * multiplicatively on the running total, while fixed markups apply
 * additively afterwards. This mirrors how merchandising teams expect pricing
 * to behave (stackable promos, then a platform mark-up).
 */

export type PricingContext = {
  /** Service date of the primary unit being priced. */
  serviceDate: Date;
  /** When the booking is being quoted (for lead-time rules). */
  quoteDate: Date;
  quantity: number;
  /** Nights for hotel-style multi-night products. */
  nights?: number;
  /** Occupancy ratio 0..1 for hotel-style products. */
  occupancy?: number;
  timeSlot?: string | null;
};

export type PriceRuleInput = {
  id: string;
  kind: PriceRuleKind;
  name: string;
  priority: number;
  conditions: unknown;
  adjustment: unknown;
  minQuantity: number;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
};

export type AppliedRule = {
  ruleId: string;
  name: string;
  kind: PriceRuleKind;
  deltaCents: number;
  runningTotalCents: number;
  note: string;
};

export type Quote = {
  basePriceCents: number;
  compareAtPriceCents: number | null;
  unitPriceCents: number;
  /** Discounts already folded into unitPriceCents. */
  discountCents: number;
  markupCents: number;
  taxCents: number;
  feeCents: number;
  totalPerUnitCents: number;
  lineTotalCents: number;
  appliedRules: AppliedRule[];
  /** True when at least one rule reduced the price below the base. */
  hasDiscount: boolean;
};

type Conditions = Record<string, unknown>;
type Adjustment = Record<string, unknown>;

/**
 * Reads a numeric bound from a rule's `conditions`, collapsing "absent" to null.
 *
 * `conditions` is a Json column, and both the seeders and the Phase 0 backfill
 * store an explicit `null` for a bound they could not supply rather than leaving
 * the key out. A `conditions.maxNights as number | undefined` therefore looks
 * correct and is not: the cast is erased at runtime, the JSON `null` arrives
 * unchanged, and `null !== undefined` passes, so "no maximum" reads as a maximum
 * of `null` — which formats as 0 and rejects every stay.
 *
 * Checking the type instead of comparing to `undefined` is the only reliable
 * way to tell "the rule sets a bound" from "the rule sets no bound".
 */
function numericBound(conditions: Conditions, key: string): number | null {
  const value = conditions[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function matchesWindow(rule: PriceRuleInput, now: Date): boolean {
  if (!rule.active) return false;
  if (rule.startsAt && rule.startsAt.getTime() > now.getTime()) return false;
  if (rule.endsAt && rule.endsAt.getTime() < now.getTime()) return false;
  if (rule.maxUses !== null && rule.usedCount >= rule.maxUses) return false;
  return true;
}

function inDateRange(date: Date, range: Conditions): boolean {
  const { from, to } = range as { from?: string; to?: string };
  if (from) {
    const start = new Date(`${from}T00:00:00.000Z`);
    if (date.getTime() < start.getTime()) return false;
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999Z`);
    if (date.getTime() > end.getTime()) return false;
  }
  return true;
}

function evaluate(
  rule: PriceRuleInput,
  context: PricingContext,
  runningTotalCents: number,
): { matched: boolean; deltaCents: number; note: string } {
  const conditions = (rule.conditions ?? {}) as Conditions;
  const adjustment = (rule.adjustment ?? {}) as Adjustment;
  const now = context.quoteDate;

  if (!matchesWindow(rule, now)) return { matched: false, deltaCents: 0, note: 'outside window' };
  if (context.quantity < rule.minQuantity) {
    return { matched: false, deltaCents: 0, note: 'quantity below minimum' };
  }

  switch (rule.kind) {
    case PriceRuleKind.BASE:
      return { matched: true, deltaCents: 0, note: 'base rate' };

    case PriceRuleKind.DATE_RANGE: {
      if (!inDateRange(context.serviceDate, conditions)) {
        return { matched: false, deltaCents: 0, note: 'date not in range' };
      }
      return applyAdjustment(adjustment, runningTotalCents, 'date range');
    }

    case PriceRuleKind.DAY_OF_WEEK: {
      const days = (conditions.days as number[]) ?? [];
      if (!days.includes(dayOfWeek(context.serviceDate))) {
        return { matched: false, deltaCents: 0, note: 'weekday not eligible' };
      }
      return applyAdjustment(adjustment, runningTotalCents, 'weekday');
    }

    case PriceRuleKind.SEASON: {
      const seasons = (conditions.seasons as { name: string; from: string; to: string }[]) ?? [];
      const match = seasons.find((s) => inDateRange(context.serviceDate, { from: s.from, to: s.to }));
      if (!match) return { matched: false, deltaCents: 0, note: 'no season match' };
      return applyAdjustment(adjustment, runningTotalCents, `season ${match.name}`);
    }

    case PriceRuleKind.LEAD_TIME: {
      const leadDays = differenceInDays(context.serviceDate, now);
      const min = numericBound(conditions, 'minLeadDays');
      const max = numericBound(conditions, 'maxLeadDays');
      if (min !== null && leadDays < min) {
        return { matched: false, deltaCents: 0, note: 'inside lead-time window' };
      }
      if (max !== null && leadDays > max) {
        return { matched: false, deltaCents: 0, note: 'outside lead-time window' };
      }
      return applyAdjustment(adjustment, runningTotalCents, `lead time ${leadDays}d`);
    }

    case PriceRuleKind.LENGTH_OF_STAY: {
      const nights = context.nights ?? 1;
      const min = numericBound(conditions, 'minNights');
      const max = numericBound(conditions, 'maxNights');
      if (min !== null && nights < min) {
        return { matched: false, deltaCents: 0, note: 'stay too short' };
      }
      if (max !== null && nights > max) {
        return { matched: false, deltaCents: 0, note: 'stay too long' };
      }
      return applyAdjustment(adjustment, runningTotalCents, `${nights} night stay`);
    }

    case PriceRuleKind.OCCUPANCY: {
      const occupancy = context.occupancy ?? 0;
      const min = numericBound(conditions, 'minOccupancy');
      const max = numericBound(conditions, 'maxOccupancy');
      if (min !== null && occupancy < min) {
        return { matched: false, deltaCents: 0, note: 'occupancy below threshold' };
      }
      if (max !== null && occupancy > max) {
        return { matched: false, deltaCents: 0, note: 'occupancy above threshold' };
      }
      return applyAdjustment(adjustment, runningTotalCents, `occupancy ${(occupancy * 100).toFixed(0)}%`);
    }

    case PriceRuleKind.QUANTITY_BREAK: {
      const min = numericBound(conditions, 'minQty');
      if (min !== null && context.quantity < min) {
        return { matched: false, deltaCents: 0, note: 'quantity break not reached' };
      }
      return applyAdjustment(adjustment, runningTotalCents, `quantity ${context.quantity}`);
    }

    case PriceRuleKind.FLASH_SALE:
    case PriceRuleKind.EARLY_BIRD:
      return applyAdjustment(adjustment, runningTotalCents, rule.kind.toLowerCase());

    default:
      return { matched: false, deltaCents: 0, note: 'unsupported rule kind' };
  }
}

function applyAdjustment(
  adjustment: Adjustment,
  runningTotalCents: number,
  note: string,
): { matched: boolean; deltaCents: number; note: string } {
  const type = (adjustment.type as string) ?? 'PERCENT_OFF';
  const value = Number(adjustment.value ?? 0);
  const maxDiscountCents = adjustment.maxDiscountCents as number | undefined;

  let deltaCents: number;
  switch (type) {
    case 'PERCENT_OFF': {
      const raw = applyBps(runningTotalCents, value);
      const capped = maxDiscountCents !== undefined ? Math.min(raw, maxDiscountCents) : raw;
      deltaCents = -capped;
      break;
    }
    case 'FIXED_OFF':
      deltaCents = -Math.min(value, runningTotalCents);
      break;
    case 'MULTIPLY':
      deltaCents = Math.round((runningTotalCents * value) / BPS_DENOMINATOR) - runningTotalCents;
      break;
    case 'SET':
      deltaCents = value - runningTotalCents;
      break;
    default:
      return { matched: false, deltaCents: 0, note: 'unsupported adjustment type' };
  }

  return { matched: true, deltaCents, note };
}

export type QuoteInput = {
  basePriceCents: number;
  compareAtPriceCents: number | null;
  taxBps: number;
  feeBps: number;
  rules: PriceRuleInput[];
  context: PricingContext;
  /** Optional per-market multiplier in bps (regional pricing). */
  regionMultiplierBps?: number;
};

export function computeQuote(input: QuoteInput): Quote {
  const { basePriceCents, compareAtPriceCents, taxBps, feeBps, rules, context } = input;
  const regionMultiplier = input.regionMultiplierBps ?? BPS_DENOMINATOR;

  let runningTotal = applyBps(basePriceCents, regionMultiplier);
  const startTotal = runningTotal;

  const applicable = [...rules].sort((a, b) => a.priority - b.priority);
  const appliedRules: AppliedRule[] = [];

  for (const rule of applicable) {
    const outcome = evaluate(rule, context, runningTotal);
    if (!outcome.matched) continue;

    runningTotal += outcome.deltaCents;
    if (runningTotal < 0) runningTotal = 0;

    appliedRules.push({
      ruleId: rule.id,
      name: rule.name,
      kind: rule.kind,
      deltaCents: outcome.deltaCents,
      runningTotalCents: runningTotal,
      note: outcome.note,
    });
  }

  const discountCents = Math.max(0, startTotal - runningTotal);
  const unitPriceCents = runningTotal;

  // Platform mark-up is transparent: it is shown as a line item at checkout
  // rather than being silently folded into the unit price.
  const markupCents = applyBps(unitPriceCents, config.booking.markupBps);
  const taxableBase = unitPriceCents + markupCents;
  const taxCents = applyBps(taxableBase, taxBps);
  const feeCents = applyBps(taxableBase, feeBps);
  const totalPerUnitCents = taxableBase + taxCents + feeCents;

  const quantity = Math.max(1, context.quantity);
  const hasDiscount = discountCents > 0;

  // Strike-through comparison price only makes sense with a real discount.
  const effectiveCompareAt =
    hasDiscount && compareAtPriceCents !== null && compareAtPriceCents > unitPriceCents
      ? compareAtPriceCents
      : null;

  return {
    basePriceCents,
    compareAtPriceCents: effectiveCompareAt,
    unitPriceCents,
    discountCents,
    markupCents,
    taxCents,
    feeCents,
    totalPerUnitCents,
    lineTotalCents: totalPerUnitCents * quantity,
    appliedRules,
    hasDiscount,
  };
}