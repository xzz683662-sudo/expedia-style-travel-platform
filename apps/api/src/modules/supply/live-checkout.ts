import { applyBps } from '../../utils/money';
import type { LiveQuote } from './live';

/**
 * ---------------------------------------------------------------------------
 * Checkout re-validation of a live rate
 * ---------------------------------------------------------------------------
 *
 * The read paths (`search`, product detail) may have quoted the shopper a
 * live-derived price. Checkout is the one place where that number becomes money,
 * so it cannot simply trust what search served minutes ago in a cache.
 *
 * This module is the *decision* only — deliberately pure, with no Prisma, no
 * network, no clock and no `liveRates` import — so the interesting cases
 * (sold out, unknown stock, drifted price, tolerance disabled) can be asserted
 * offline by `prisma/live-contract-check.ts` without a binary or a credential.
 * `modules/booking/engine.ts` does the resolving and turns a verdict into an
 * `AppError`; this file only decides.
 *
 * The three-way `sellable` contract from `live.ts` is load-bearing here and must
 * not be collapsed:
 *
 *   `null`  the source did not say. Never blocks a sale — the local inventory
 *           engine already agreed to hold the units, and a source that cannot
 *           prove stock must not overrule it.
 *   `0`     confirmed sold out. Blocks the sale.
 *   `n`     a real count. Blocks only when it is below the requested quantity.
 */

/** What checkout should do with one line, given a live quote (or none). */
export type CheckoutLiveVerdict =
  | { kind: 'ok'; basePriceCents: number }
  | { kind: 'sold_out'; available: number; requested: number }
  | {
      kind: 'price_changed';
      /** The catalogue price — the reference the live rate drifted away from. */
      previousUnitPriceCents: number;
      currentUnitPriceCents: number;
      currency: string;
    };

/**
 * Decides whether a live quote may be used at checkout, and at what price.
 *
 * @param quote                  The live net rate, or `null` when no source
 *                               answered (the layer is off, every source
 *                               declined, or the category has no live source).
 * @param quantity               Units the shopper is buying on this line.
 * @param catalogBasePriceCents  `TicketType.basePriceCents` — a pre-markup cost,
 *                               so it is directly comparable to
 *                               `quote.netPriceCents`.
 * @param toleranceBps           Maximum tolerated gap between the two, in basis
 *                               points. `<= 0` disables the drift guard.
 */
export function evaluateCheckoutLive(input: {
  quote: LiveQuote | null;
  quantity: number;
  catalogBasePriceCents: number;
  toleranceBps: number;
}): CheckoutLiveVerdict {
  const { quote, quantity, catalogBasePriceCents, toleranceBps } = input;

  // No source answered: the catalogue price stands, exactly as it did before
  // this layer existed. Not an error — this is the intended degradation.
  if (!quote) return { kind: 'ok', basePriceCents: catalogBasePriceCents };

  // A source can prove sold out; it can never prove in stock, so a `null`
  // (unknown) count is not a reason to refuse a sale the inventory engine has
  // already agreed to hold.
  if (quote.sellable !== null && quote.sellable < quantity) {
    return { kind: 'sold_out', available: quote.sellable, requested: quantity };
  }

  // Drift guard, off by default. A live rate is *expected* to differ from the
  // seeded catalogue figure, so enforcing equality would reject every order the
  // moment a live source is switched on — which would make the layer unusable
  // rather than safe. Operators who intend the catalogue price to act as a
  // ceiling opt in with a non-zero tolerance.
  if (toleranceBps > 0) {
    const allowedDrift = applyBps(catalogBasePriceCents, toleranceBps);
    const drift = Math.abs(quote.netPriceCents - catalogBasePriceCents);
    if (drift > allowedDrift) {
      return {
        kind: 'price_changed',
        previousUnitPriceCents: catalogBasePriceCents,
        currentUnitPriceCents: quote.netPriceCents,
        currency: quote.currency,
      };
    }
  }

  return { kind: 'ok', basePriceCents: quote.netPriceCents };
}
