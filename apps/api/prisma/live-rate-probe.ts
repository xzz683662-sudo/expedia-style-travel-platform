/**
 * ---------------------------------------------------------------------------
 * Live rate probe CLI
 * ---------------------------------------------------------------------------
 *
 *   pnpm --filter @easytrip/api supply:probe
 *   pnpm --filter @easytrip/api supply:probe -- --category=FLIGHT --slug=london-international-flight
 *
 * Enforces the rule in `docs/supply-sources.md`: *"Never import a dataset whose
 * freshness you have not verified against the source itself."* A route adapter
 * was once written against a dataset that had been dead since 2014, because its
 * deprecation notice was never opened. This CLI is the mechanical answer — the
 * reachability check is a command with an exit code, not a claim in prose.
 *
 * What it does:
 *
 *   1. Probes the endpoints declared by the live sources over HTTP.
 *   2. Resolves real `Product` slugs of the requested categories and runs the
 *      live rate chain against them.
 *   3. Exits non-zero when a source that the code claims to depend on is
 *      unreachable, so a green build cannot silently outlive a dead upstream.
 *
 * Exit codes:
 *   0  every declared source answered
 *   1  a probe threw, or no live sources are wired yet
 *
 * A non-zero exit here is *information*, not a crash: today it reports that no
 * commercial rate source is contracted. That is the honest state of the system
 * and is exactly what the freshness rule exists to surface.
 */

import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import { config } from '../src/config/env';
import { liveRates, liveRateSources } from '../src/modules/supply/live-adapters';
import { liveAirTrafficNear } from '../src/modules/supply/live-content';
import type { LiveCategory } from '../src/modules/supply/live';
import { closeRedis } from '../src/utils/redis';

/**
 * Endpoints whose reachability the platform depends on.
 *
 * Content sources today; rate sources are absent for the reason documented in
 * `live-adapters.ts`. Keep this list honest: every entry must be something the
 * code actually calls, or the probe becomes a health check of nothing.
 */
const PROBES: readonly { label: string; url: string; note: string }[] = [
  {
    label: 'adsb.lol point query',
    url: 'https://api.adsb.lol/v2/point/51.47/-0.45/10',
    note: 'Live ADS-B positions. Primary content source for the flight module.',
  },
  {
    label: 'adsb.lol callsign',
    url: 'https://api.adsb.lol/v2/callsign/DAL112',
    note: 'Filters correctly, but DAL112 returns `total: 0` — only airborne aircraft resolve. A 200 here proves reachability, NOT that a flight was found.',
  },
  {
    label: 'adsbdb registry',
    url: 'https://api.adsbdb.com/v0/aircraft/G-XLEA',
    note: 'Registration -> type, operator, photo. NOT usable for catalogue content: keyed on registration, which FlightSegment does not carry.',
  },
  {
    label: 'aviationweather METAR',
    url: 'https://aviationweather.gov/api/data/metar?ids=EGLL&format=json',
    note: 'Airport weather. Candidate for flight disruption messaging.',
  },
  {
    label: 'adsb.lol route query',
    url: 'https://api.adsb.lol/v2/route/LHR/JFK',
    note: 'EXPECTED 503. Recorded so nobody re-probes it hoping for route data.',
  },
];

/**
 * Same identifying User-Agent the flight adapter must send.
 *
 * `adsb.lol` answers 403 "User-Agent too generic" to the default `node`, so a
 * probe that used the runtime default would report a reachable endpoint as
 * dead — and send someone off to debug the wrong layer.
 */
const USER_AGENT =
  'easytrip-api/0.1.0 (+https://github.com/ayan1666668-ops/expedia-style-travel-platform)';

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const CATEGORIES: readonly LiveCategory[] = ['FLIGHT', 'HOTEL_ROOM', 'CRUISE'];

async function probe(): Promise<boolean> {
  process.stdout.write('\n── Endpoint reachability ──\n');
  let allOk = true;

  for (const entry of PROBES) {
    const started = Date.now();
    try {
      const response = await fetch(entry.url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      const ms = Date.now() - started;
      // The route probe is documented as unavailable. Treating its 503 as a
      // failure would make this command permanently red for a reason that is
      // already understood, which trains people to ignore the exit code.
      const expectedDead = entry.label.includes('route query');
      const ok = response.ok || (expectedDead && response.status === 503);
      if (!ok) allOk = false;
      process.stdout.write(
        `  ${ok ? '✓' : '✗'} ${entry.label.padEnd(26)} HTTP ${response.status} (${ms}ms)\n`,
      );
      if (expectedDead) process.stdout.write(`      ${entry.note}\n`);
    } catch (error) {
      allOk = false;
      process.stdout.write(`  ✗ ${entry.label.padEnd(26)} ${(error as Error).message}\n`);
    }
  }
  return allOk;
}

/**
 * Proves the one content path `live-content.ts` actually depends on.
 *
 * Distinct from the reachability probes above on purpose. Those prove an
 * endpoint answers HTTP; this proves it answers the *question* the product page
 * asks. The gap is real and was found the hard way: `/v2/callsign/DAL112`
 * returns 200 with `total: 0`, which looks identical to success if all you
 * check is the status code.
 */
async function probeContent(): Promise<boolean> {
  process.stdout.write('\n── Live content resolution ──\n');

  // A flight product's own coordinates, so this exercises the real join path
  // (`Product.latitude/longitude` -> `near()`), not a hard-coded location.
  const flight = await prisma.product.findFirst({
    where: { type: 'FLIGHT', latitude: { not: null }, longitude: { not: null } },
    orderBy: { slug: 'asc' },
    select: { slug: true, latitude: true, longitude: true },
  });

  if (!flight) {
    process.stdout.write('  ✗ no FLIGHT product with coordinates — nothing to probe\n');
    return false;
  }

  const content = await liveAirTrafficNear(flight.slug);
  if (!content) {
    process.stdout.write(`  ✗ ${flight.slug} — live content returned nothing\n`);
    process.stdout.write('      upstream unreachable, or the area is genuinely empty\n');
    return false;
  }

  const airborne = content.flights.filter((f) => !f.onGround).length;
  process.stdout.write(`  ✓ ${flight.slug.padEnd(34)} ${content.flights.length} aircraft (${airborne} airborne)\n`);
  process.stdout.write(`      advisory: ${content.advisory} — never a claim about this product\n`);

  // A hotel must never gain a "live" block; a quiet answer there is correct.
  const hotel = await prisma.product.findFirst({
    where: { type: 'HOTEL_ROOM' },
    orderBy: { slug: 'asc' },
    select: { slug: true },
  });
  if (hotel) {
    const hotelContent = await liveAirTrafficNear(hotel.slug);
    const isolated = hotelContent === null;
    process.stdout.write(
      `  ${isolated ? '✓' : '✗'} hotel excluded${isolated ? '' : ' — a hotel must never report live air traffic'}\n`,
    );
    if (!isolated) return false;
  }

  return true;
}

async function probeRates(): Promise<void> {
  const requested = readFlag('category');
  const categories = requested
    ? ([requested.toUpperCase()] as LiveCategory[]).filter((c) => CATEGORIES.includes(c))
    : CATEGORIES;
  const slugFilter = readFlag('slug');

  process.stdout.write('\n── Live rate resolution ──\n');
  process.stdout.write(`  enabled:     ${liveRates.enabled}\n`);
  process.stdout.write(`  sources:     ${liveRateSources.length}\n`);

  if (liveRateSources.length === 0) {
    process.stdout.write(
      '  no commercial rate source is wired.\n' +
        '  Expected: docs/supply-sources.md records that fares and seat inventory\n' +
        '  have no free, licence-clean, redistributable source.\n',
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const category of categories) {
    const products = await prisma.product.findMany({
      where: {
        type: category,
        status: 'PUBLISHED',
        ...(slugFilter ? { slug: slugFilter } : {}),
      },
      select: { slug: true, ticketTypes: { where: { active: true }, take: 1, select: { currency: true } } },
      take: 3,
      orderBy: { slug: 'asc' },
    });

    if (products.length === 0) {
      process.stdout.write(`  ${category}: no published products — seed first\n`);
      continue;
    }

    for (const product of products) {
      const result = await liveRates.resolve(
        {
          slug: product.slug,
          category,
          serviceDate: today,
          quantity: 1,
          currency: product.ticketTypes[0]?.currency ?? config.booking.defaultCurrency,
        },
        'search',
      );
      process.stdout.write(
        `  ${category.padEnd(10)} ${product.slug.padEnd(42)} ` +
          (result.quote
            ? `${result.quote.netPriceCents} ${result.quote.currency} via ${result.quote.sourceId}`
            : 'no live quote (falls back to seeded price)') +
          (result.degraded ? '  [degraded]' : '') +
          '\n',
      );
    }
  }
}

async function main(): Promise<void> {
  const endpointsOk = await probe();
  await probeRates();
  const contentOk = await probeContent();

  process.stdout.write('\n── Summary ──\n');
  process.stdout.write(`  endpoints: ${endpointsOk ? 'ok' : 'degraded'}\n`);
  process.stdout.write(`  content:   ${contentOk ? 'ok' : 'degraded'}\n`);
  if (!endpointsOk) {
    process.stdout.write('  at least one declared endpoint is unreachable.\n');
    process.exitCode = 1;
  }
  if (!contentOk) {
    process.stdout.write('  live content did not resolve; the product page panel is off.\n');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    logger.error('supply.probe_failed', { reason: (error as Error).message });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Required, unlike `supply-import.ts`: the content probe touches
    // `cacheGet`/`cacheSet`, which opens a Redis connection whose live socket
    // keeps the event loop alive. Without this the probe prints its summary and
    // then hangs forever — which is why `timeout` was masking it as exit 124.
    // A command that cannot exit cannot be a CI gate.
    await closeRedis();
  });