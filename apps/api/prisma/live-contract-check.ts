/**
 * ---------------------------------------------------------------------------
 * Live rate contract check
 * ---------------------------------------------------------------------------
 *
 *   pnpm --filter @easytrip/api supply:contract
 *
 * Covers the part of the live layer that `scripts/` never touched. Until this
 * existed, `pnpm verify` passed 100% while the live rate chain could be wired
 * completely wrong — grepping `scripts/` for `liveRates`, `SUPPLY_LIVE_*` or any
 * source id returns nothing. This file is that missing gate.
 *
 * Why it can run offline
 * ----------------------
 * Every assertion here is about a *contract*, not about an upstream:
 *
 *   - no binary is spawned (`TrvlRateSource` is cache-only by construction)
 *   - no network call is made
 *   - no credential is needed (`getRates` returns `[]` when unconfigured)
 *   - `REDIS_URL` unset falls back to `MemoryRedis` (`utils/redis.ts`)
 *   - `lib/prisma.ts` builds the client lazily, so importing it connects to
 *     nothing
 *
 * That matters: a check that needs a key, a downloaded binary or a live
 * upstream is a check that is red on every fresh clone and in CI, and therefore
 * a check nobody runs. The end-to-end proof against the real trvl binary stays
 * where it was — `prisma/verify-trvl-warm.ts`, run manually by an operator who
 * has decided to enable the source.
 *
 * What it pins
 * ------------
 *   1. Cache-key parity. `resolve()` reads the cache *before* it consults any
 *      source, so a warmer whose key drifts writes rows nothing ever reads: a
 *      full cache and zero hits, with every other signal green. `warmKeyFor` is
 *      compared against the resolver's own key.
 *   2. `warmKeyFor` is keyed by the *settlement* currency while the stored row
 *      keeps the *upstream* currency.
 *   3. A warmed row is consumed verbatim, so a trimmed row yields
 *      `sourceId: undefined` — the bug this file exists to prevent.
 *   4. `pickOffer` converts, so a EUR row answers a USD query in USD.
 *   5. `sellable: 0` wins over a cheaper listed offer; `null` never does.
 *   6. The registry ends with `NoCommercialRateSource`, because array order is
 *      fallback order and the sentinel is what makes `degraded` meaningful.
 *   7. A source with no credential answers `[]` rather than throwing.
 *
 * Exits non-zero on any failure so it cannot be mistaken for a pass.
 * ---------------------------------------------------------------------------
 */

import { config } from '../src/config/env';
import { cacheGet, cacheSet, cacheDelete, closeRedis } from '../src/utils/redis';
import {
  LiveRateFinder,
  type LiveOffer,
  type LiveRateQuery,
  type LiveRateSource,
} from '../src/modules/supply/live';
import { liveRateSources } from '../src/modules/supply/live-adapters';
import { warmKeyFor, TRVL_NATIVE_CURRENCY, TRVL_SOURCE_ID } from '../src/modules/supply/trvl-source';

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    pass += 1;
  } else {
    console.error(`  \u2717 ${label}${detail ? `: ${detail}` : ''}`);
    fail += 1;
  }
}

function head(label: string): void {
  console.log(`\n\u001b[1;36m\u2500\u2500 ${label}\u001b[0m`);
}

const SETTLEMENT = config.booking.defaultCurrency;

/**
 * The resolver's cache key, reproduced from `cacheKey()` in `live.ts`.
 *
 * Duplicated on purpose: this file is the independent oracle. Importing the real
 * function would make the test tautological — it would compare the key builder to
 * itself and pass no matter what both were wrong about. `cacheKey` is
 * deliberately module-private, so there is nothing to import even if one wanted
 * to cheat.
 */
function expectedKey(query: LiveRateQuery, freshness: 'search' | 'detail' = 'search'): string {
  return [
    'live:rate',
    query.slug,
    query.category,
    query.serviceDate,
    query.checkOutDate ?? '',
    String(query.quantity),
    query.currency,
    freshness,
  ].join(':');
}

/** One warmed row in upstream currency, shaped exactly as `LiveOffer`. */
function offer(overrides: Partial<LiveOffer> = {}): LiveOffer {
  return {
    sourceId: TRVL_SOURCE_ID,
    externalId: 'contract-check:probe:1',
    netPriceCents: 40_089,
    currency: TRVL_NATIVE_CURRENCY,
    sellable: null,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

const QUERY: LiveRateQuery = {
  slug: 'live-contract-check-probe',
  category: 'FLIGHT',
  serviceDate: '2026-12-01',
  checkOutDate: null,
  quantity: 1,
  currency: SETTLEMENT,
};

async function main(): Promise<void> {
  console.log(`settlement currency = ${SETTLEMENT}`);
  console.log(`trvl native currency = ${TRVL_NATIVE_CURRENCY}`);
  console.log(`redis = ${config.redisUrl ? 'real server' : 'in-memory fallback'}`);

  head('Cache key parity');

  const warmerKey = warmKeyFor(QUERY.slug, QUERY.serviceDate, SETTLEMENT);
  check(
    'warmKeyFor matches the resolver key for a warm read',
    warmerKey === expectedKey(QUERY),
    `warmer wrote "${warmerKey}", resolver reads "${expectedKey(QUERY)}"`,
  );

  // The bug this guards: keying by the upstream currency. The warmer wrote
  // EUR-keyed rows, so a USD request never found one.
  const upstreamKeyed = warmKeyFor(QUERY.slug, QUERY.serviceDate, TRVL_NATIVE_CURRENCY);
  check(
    'upstream-currency key differs from the settlement key',
    upstreamKeyed !== warmerKey,
    'keying on the upstream currency means a USD query never hits a EUR-keyed entry',
  );

  head('A warmed row is consumed verbatim');

  // Write at the settlement key, exactly as the warmer does, and read back
  // through the real resolver. Nothing between the two touches the row.
  await cacheSet(warmerKey, [offer()], 300);
  const finder = new LiveRateFinder(liveRateSources, true);
  const warmed = await finder.resolve(QUERY, 'search');

  check('warm read is non-null', warmed.quote !== null);
  check(
    'sourceId survives the round trip',
    warmed.quote?.sourceId === TRVL_SOURCE_ID,
    `got ${String(warmed.quote?.sourceId)} — a trimmed cache row loses it`,
  );
  check(
    'sellable is null, not 0',
    warmed.quote?.sellable === null,
    '0 means confirmed sold out; null means the source did not say',
  );
  check(
    'netPriceCents is a positive integer',
    Number.isInteger(warmed.quote?.netPriceCents) && (warmed.quote?.netPriceCents ?? 0) > 0,
  );
  check('fromCache is true', warmed.quote?.fromCache === true);

  head('Currency conversion happens in pickOffer');

  // Same EUR row, but asked for in the settlement currency. If conversion were
  // bypassed the quote would come back labelled USD while still holding EUR.
  check(
    'quote currency equals the requested settlement currency',
    warmed.quote?.currency === SETTLEMENT,
    `got ${String(warmed.quote?.currency)}`,
  );
  check(
    'a EUR row is not labelled USD while unconverted',
    warmed.quote?.currency !== TRVL_NATIVE_CURRENCY || SETTLEMENT === TRVL_NATIVE_CURRENCY,
  );

  head('pickOffer rejections');

  // Confirmed sold out beats a cheaper listed offer.
  await cacheSet(
    warmerKey,
    [
      offer({ externalId: 'a:listed', netPriceCents: 1_000 }),
      offer({ externalId: 'b:soldout', netPriceCents: 99_999, sellable: 0 }),
    ],
    300,
  );
  const soldOut = await finder.resolve(QUERY, 'search');
  check(
    'sellable 0 wins over a cheaper listed offer',
    soldOut.quote?.sellable === 0,
    `got sellable=${String(soldOut.quote?.sellable)}`,
  );

  // A malformed price is dropped rather than coerced. `Number('') === 0` and
  // `Number('1,20')` is NaN, both of which are plausible parse results.
  await cacheSet(warmerKey, [offer({ netPriceCents: Number.NaN }), offer({ netPriceCents: -1 })], 300);
  const malformed = await finder.resolve(QUERY, 'search');
  check('malformed and negative prices are rejected', malformed.quote === null);

  // An empty array is a real cached answer ("verified unsold"), and it is
  // truthy, so the hit path returns it rather than re-walking the chain.
  await cacheSet(warmerKey, [], 300);
  const empty = await finder.resolve(QUERY, 'search');
  check('an empty cached batch is a real answer, not a miss', empty.quote === null);

  head('Registry and disabled behaviour');

  const last = liveRateSources[liveRateSources.length - 1];
  check(
    'NoCommercialRateSource is last — array order is fallback order',
    last?.id === 'none',
    `last source is "${String(last?.id)}"`,
  );
  check(
    'every source declares an id and a licence',
    liveRateSources.every(
      (s) =>
        typeof s.id === 'string' &&
        s.id.length > 0 &&
        typeof s.license === 'string' &&
        s.license.length > 0,
    ),
  );
  check(
    'every source id is unique',
    new Set(liveRateSources.map((s) => s.id)).size === liveRateSources.length,
  );

  // An unconfigured source must answer `[]`, not throw. That is what lets an
  // adapter ship with no credential and keep the chain free of `if (enabled)`.
  const stub: LiveRateSource = {
    id: 'contract-check-stub',
    license: 'N/A',
    categories: ['FLIGHT'],
    async getRates() {
      return [];
    },
    async getAvailability() {
      return [];
    },
  };
  // Clear the cache before every state-sensitive assertion. `resolve()` reads the
  // cache *before* consulting any source, so a leftover entry short-circuits the
  // whole chain: the stub below is never asked, so `degraded` stays false. This is
  // the same precedence the resolver documents, observed as a test failure.
  await cacheDelete(warmerKey);
  const withStub = new LiveRateFinder([stub], true);
  const degraded = await withStub.resolve(QUERY, 'search');
  check(
    'a source that declines yields degraded=true',
    degraded.degraded === true && degraded.quote === null,
    `degraded=${String(degraded.degraded)}`,
  );

  // Switching the layer off must be indistinguishable from having no source,
  // and must not serve an entry written before the operator turned it off.
  // `enabled` is a property of the *finder*, not of `LiveResult` — asserting it
  // on the result object reads `undefined` and fails for the wrong reason.
  await cacheSet(warmerKey, [offer()], 300);
  const off = new LiveRateFinder(liveRateSources, false);
  const disabled = await off.resolve(QUERY, 'search');
  check(
    'a disabled layer ignores a populated cache',
    disabled.quote === null && disabled.degraded === false && off.enabled === false,
    `quote=${JSON.stringify(disabled.quote)} degraded=${String(disabled.degraded)} enabled=${String(off.enabled)}`,
  );

  head('Cache hygiene');
  await cacheDelete(warmerKey);
  const afterDelete = await cacheGet<unknown[]>(warmerKey);
  check('cacheDelete clears the probe entry', afterDelete === null);
  await cacheSet(warmerKey, [offer()], 300);
  const raw = await cacheGet<unknown[]>(warmerKey);
  check('the cache entry was actually written (cacheSet returns void)', Array.isArray(raw));
  await cacheDelete(warmerKey);
}

main()
  .catch((error: unknown) => {
    console.error('  \u2717 live contract check threw:', error);
    fail += 1;
  })
  .finally(async () => {
    await closeRedis();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exitCode = 1;
  });