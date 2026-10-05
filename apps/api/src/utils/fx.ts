import { config } from '../config/env';
import { logger } from '../lib/logger';
import { cacheGet, cacheSet } from './redis';
import { minorUnits, roundCents } from './money';

/**
 * ---------------------------------------------------------------------------
 * FX — converting an upstream rate into the currency the platform sells in
 * ---------------------------------------------------------------------------
 *
 * Why this exists
 * ---------------
 * Upstreams answer in whatever currency they feel like. trvl answers EUR and
 * nothing else (`--currency` was measured and ignored); Kiwi answers the
 * seller's currency; a future cruise feed will answer USD. The platform, on the
 * other hand, sells in whatever `TicketType.currency` says — eight currencies
 * are in the catalogue today.
 *
 * Without this module `pickOffer` discarded every offer whose currency did not
 * match the seller, which silently cut ~58% of the catalogue (389 of 677 ticket
 * types) off from live pricing. The matcher was correct, not wrong: it existed
 * to stop `computeQuote` treating 100 EUR as 100 USD, since that function does
 * no FX conversion. This module is what makes the match *achievable*.
 *
 * What this module does NOT do
 * ----------------------------
 * It never rewrites stored money. `TicketType.basePriceCents` is the price a
 * *previous* order was priced against; converting it at today's rate would
 * rewrite history (see AGENTS.md, "Prices never mutate"). The repository
 * already models FX the right way for the retail side — `PriceList` with a
 * `bpsMultiplier`, commented `10000 = no FX conversion applied` — and this
 * layer is its counterpart on the cost side, applied at resolve time and only
 * to a number that is about to be displayed.
 *
 * The settlement currency is therefore untouched: an order is still paid in
 * `TicketType.currency`. This converts what we *display* and what we *compare*,
 * nothing else.
 *
 * Rounding
 * --------
 * Rates are floats; money is integers. The conversion happens once, in minor
 * units, half-up on the final cent — the same rule `roundCents` applies
 * everywhere else here. Rounding is applied at the *end* of the chain, never
 * per-rate-hop, so a EUR→USD conversion is a single rounding event.
 */

const FRESH_SECONDS = 6 * 60 * 60; // FX moves slowly; a 6h-old rate is current enough.
const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

/** `USD` is the platform's reporting currency (`CURRENCY_DEFAULT`). */
export const REPORTING_CURRENCY = 'USD';

interface RateTable {
  /** Units of `base` per 1 USD. Inverted into `to`/`from` at read time. */
  base: string;
  /** `EUR` → 0.85 (i.e. 1 USD = 0.85 EUR). */
  perUsd: Record<string, number>;
  /** Epoch ms when the upstream published this table. */
  fetchedAt: number;
}

let inFlight: Promise<RateTable | null> | null = null;

function cacheKey(): string {
  return `fx:rates:${REPORTING_CURRENCY}`;
}

/**
 * The upstream table, or `null`.
 *
 * `null` is a real answer and must never be treated as "rate is 1". A missing
 * rate table has to leave the caller on its existing price rather than let a
 * fabricated identity conversion silently reprice the catalogue.
 */
async function loadTable(): Promise<RateTable | null> {
  const cached = await cacheGet<RateTable>(cacheKey());
  if (cached && Date.now() - cached.fetchedAt < STALE_GRACE_MS) return cached;

  // Single-flight: a search prices dozens of products, and without this every
  // one of them would fire its own request at the rate provider.
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const url = `${config.fx.baseUrl}/${REPORTING_CURRENCY}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.fx.timeoutMs);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { result?: string; rates?: Record<string, number> };
        if (body.result !== 'success' || !body.rates) throw new Error('unexpected payload');

        const perUsd: Record<string, number> = {};
        for (const [code, value] of Object.entries(body.rates)) {
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) perUsd[code] = value;
        }
        if (!perUsd[REPORTING_CURRENCY]) return null;

        const table: RateTable = { base: REPORTING_CURRENCY, perUsd, fetchedAt: Date.now() };
        await cacheSet(cacheKey(), table, FRESH_SECONDS);
        return table;
      } catch (error) {
        // A rate provider being down must not break search. `null` propagates
        // and every caller falls back to the seeded price.
        logger.warn('fx.rate_table_failed', { reason: (error as Error).message });
        return null;
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

/**
 * Best-effort FX rate: how many units of `from` one unit of `to` buys.
 *
 * `null` means "not convertible" — an unknown code, or no rate table. Callers
 * must treat that as *no answer*, never as `1`.
 */
export async function rate(from: string, to: string): Promise<number | null> {
  const src = from.toUpperCase();
  const dst = to.toUpperCase();

  // Identity: converting a currency to itself is exact and needs no rate table,
  // so it must succeed even with the provider down. This is also the reason the
  // platform's own USD catalogue keeps working when FX is unavailable.
  if (src === dst) return 1;

  const table = await loadTable();
  if (!table) return null;

  const fromRate = table.perUsd[src];
  const toRate = table.perUsd[dst];
  if (!fromRate || !toRate) return null;

  const converted = fromRate / toRate;
  return Number.isFinite(converted) && converted > 0 ? converted : null;
}

/**
 * Converts an amount between currencies, preserving minor units.
 *
 * `amountCents` is in the minor unit of `from`; the result is in the minor unit
 * of `to`. That distinction matters: JPY and KRW have no minor unit, so 100 JPY
 * is `100`, not `10000`. Converting the major unit and re-scaling here is what
 * keeps a 0-decimal currency from silently becoming a 2-decimal one.
 *
 * Returns `null` rather than a guess when the rate is unavailable.
 */
export async function convertMinorUnits(
  amountCents: number,
  from: string,
  to: string,
): Promise<number | null> {
  if (!Number.isFinite(amountCents)) return null;
  const src = from.toUpperCase();
  const dst = to.toUpperCase();
  if (src === dst) return roundCents(amountCents);

  const fx = await rate(src, dst);
  if (fx === null) return null;

  // Scale from `from`'s minor unit to major, convert, then into `to`'s.
  const major = amountCents / Math.pow(10, minorUnits(src));
  const converted = major * fx;
  return roundCents(converted * Math.pow(10, minorUnits(dst)));
}