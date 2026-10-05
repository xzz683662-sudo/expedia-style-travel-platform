import { KiwiRateSource } from './kiwi-source';
import { LiveRateFinder, type LiveAvailability, type LiveCategory, type LiveOffer, type LiveRateQuery, type LiveRateSource } from './live';

/**
 * ---------------------------------------------------------------------------
 * Live rate adapters
 * ---------------------------------------------------------------------------
 *
 * `docs/supply-sources.md` states the core constraint in the repo's own words:
 * *"Schedule, fare and seat inventory cannot come from open data at all. They
 * are regulated commercial assets airlines distribute through GDS/NDC partners;
 * there is no free, licence-clean, commercially redistributable source."*
 *
 * That was re-verified against live upstreams on 2026-10-05, because the
 * freshness rule in that document requires probing a source before trusting it:
 *
 *   GET api.amadeus.com/v1/security/oauth2/token
 *     -> JSON "blocked by our security service" (self-service portal was
 *        decommissioned 2025-07-17; enterprise access is by sales agreement)
 *   GET tequila-api.kiwi.com/v2/search?fly_from=SFO
 *     -> 403 {"error_code":403,"message":"'apikey' header is required"}
 *        (alive, credential enforced, partner agreement required)
 *   GET api.kiwi.com/v2/search
 *     -> Could not resolve host (no such hostname)
 *
 * Open endpoints were probed at the same time and still return position or
 * metadata only — never a fare, a seat count or a room allotment:
 *
 *   GET opensky-network.org/api/states/all  -> 200 (positions)
 *   GET api.adsb.lol/v2/point/...            -> 503 at time of check
 *   GET api.open-meteo.com/v1/forecast      -> 200 (weather, commercial terms absent)
 *   GET en.wikipedia.org/api/rest_v1/...     -> 200 (descriptive content)
 *
 * So the one adapter wired here is {@link KiwiRateSource}, a *metasearch
 * aggregator* rather than an inventory holder. What that means is stated in its
 * own docs: it moves the price the shopper is quoted, and it does not create a
 * confirmed upstream reservation. It also returns no availability, because
 * fabricating capacity from a nightly price would sell seats the platform never
 * confirmed.
 *
 * {@link NoCommercialRateSource} stays last: it cannot answer anything, so its
 * position costs nothing, and its presence is what lets `degraded` distinguish
 * "no source answered" (true) from "the layer is switched off" (false).
 *
 * Adding a further real source means: implement `getRates`, append it to
 * {@link liveRateSources}, and set `SUPPLY_LIVE_ENABLED=true`. No call site
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
export const liveRateSources: readonly LiveRateSource[] = [
  new KiwiRateSource(),
  new NoCommercialRateSource(),
];

/**
 * The live rate chain, and the only instance the API should use.
 *
 * Constructed once with `config.supply.live.enabled` captured at construction
 * time. That is intentional: the flag is read once, so a mid-process env change
 * cannot leave the cache serving entries written under a different setting.
 */
export const liveRates = new LiveRateFinder(liveRateSources);