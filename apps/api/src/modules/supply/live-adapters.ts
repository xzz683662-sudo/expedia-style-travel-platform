import { LiveRateFinder, type LiveAvailability, type LiveCategory, type LiveOffer, type LiveRateQuery, type LiveRateSource } from './live';

/**
 * ---------------------------------------------------------------------------
 * Live rate adapters
 * ---------------------------------------------------------------------------
 *
 * Shipped in Phase 1: the seam only. No commercial adapter is wired yet, and
 * that is a deliberate, documented state rather than an unfinished one.
 *
 * Why there is no rate adapter
 * ----------------------------
 * `docs/supply-sources.md` states it in the repo's own words: *"Schedule, fare
 * and seat inventory cannot come from open data at all. They are regulated
 * commercial assets airlines distribute through GDS/NDC partners; there is no
 * free, licence-clean, commercially redistributable source."*
 *
 * That was re-verified against live upstreams on 2026-10-04 rather than taken
 * on trust, because the freshness rule in that document requires probing the
 * source before trusting it:
 *
 *   GET api.adsb.lol/v2/point/51.47/-0.45/10  -> 200  (positions only)
 *   GET api.adsb.lol/v2/callsign/DAL112      -> 200  (positions only)
 *   GET api.adsb.lol/v2/route/LHR/JFK        -> 503  (no route-level data)
 *   GET api.adsbdb.com/v0/aircraft/G-XLEA    -> 200  (registry metadata only)
 *
 * Every reachable endpoint carries position or registry metadata. None carries
 * a fare, a seat count or a room allotment. Wiring an adapter to them would mean
 * inventing commercial terms, which is precisely the failure mode that erodes
 * trust in a checkout funnel.
 *
 * So the correct adapter today is one that declines. It returns `[]`, which the
 * resolver reads as "this source carries no data" rather than "unavailable", and
 * the caller falls back to `TicketType.basePriceCents`. Content real-time
 * (Phase 2) uses the proven 200s above and is independent of this file.
 *
 * Adding a real commercial source later means: implement `getRates`, append it
 * to {@link liveRateSources}, and set `SUPPLY_LIVE_ENABLED=true`. No call site
 * changes — that is the entire point of the interface.
 */

/**
 * Declines every category.
 *
 * Present so the resolver always has at least one source to consult, which is
 * what makes `degraded` meaningful: with this in the chain, "nothing answered"
 * is a real observation about the upstream world rather than an artefact of an
 * empty array.
 */
export class NoCommercialRateSource implements LiveRateSource {
  readonly id = 'none';
  readonly license = 'N/A';
  readonly categories: readonly LiveCategory[] = [];

  async getRates(_query: LiveRateQuery): Promise<LiveOffer[]> {
    return [];
  }

  async getAvailability(_query: LiveRateQuery): Promise<LiveAvailability[]> {
    return [];
  }
}

/**
 * The enumeration order is the fallback order.
 *
 * `NoCommercialRateSource` stays last deliberately. It cannot answer anything,
 * so its position costs nothing, and keeping it in the chain is what lets
 * `degraded` distinguish "no commercial source is wired" (true) from "the layer
 * is switched off" (false).
 *
 * Exported so `prisma/live-rate-probe.ts` can walk the chain and probe each
 * adapter individually rather than only exercising the composed resolver.
 */
export const liveRateSources: readonly LiveRateSource[] = [new NoCommercialRateSource()];

/**
 * The live rate chain, and the only instance the API should use.
 *
 * Constructed once with `config.supply.live.enabled` captured at construction
 * time. That is intentional: the flag is read once, so a mid-process env change
 * cannot leave the cache serving entries written under a different setting.
 */
export const liveRates = new LiveRateFinder(liveRateSources);