/**
 * End-to-end proof for the trvl pre-warm path.
 *
 * Runs the real binary through the real warmer, then reads the result back
 * through the real adapter, and asserts the two agree. Run manually:
 *
 *   (cd apps/api && set -a && . ../../.env && set +a \
 *     && TRVL_ENABLED=true TRVL_BINARY_PATH=/tmp/trvltest/trvl \
 *        npx tsx prisma/verify-trvl-warm.ts)
 *
 * Exits non-zero on any failure so it cannot be mistaken for a pass.
 */
import { config } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { liveRates } from '../src/modules/supply/live-adapters';
import { warmTrvlRoute } from '../src/modules/supply/trvl-source';
import type { LiveRateQuery } from '../src/modules/supply/live';

function ok(label: string, value: unknown): void {
  console.log(`  ✓ ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function bad(label: string, detail: string): void {
  console.error(`  ✗ ${label}: ${detail}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log('TRVL_ENABLED =', config.supply.trvl.enabled);
  console.log('TRVL_BINARY_PATH =', config.supply.trvl.binaryPath || '(empty)');
  if (!config.supply.trvl.enabled) {
    bad('precondition', 'set TRVL_ENABLED=true');
    return;
  }

  // Only EUR-selling flights can be warmed: trvl answers in EUR regardless of the
// `--currency` flag, so any other currency would be discarded by `pickOffer`.
// Selecting on currency here keeps the test honest about what it can prove.
const flight = await prisma.productFlight.findFirst({
  where: { product: { ticketTypes: { some: { active: true, currency: 'EUR' } } } },
  orderBy: { updatedAt: 'desc' },
  select: { productId: true, product: { select: { slug: true } } },
});
  if (!flight) {
    bad('precondition', 'no flight product in the catalogue');
    return;
  }

  // `ProductFlight.segments` is Json and cannot be filtered or ordered by Prisma,
  // so the legs come from the `FlightSegment` table — the queryable copy.
  const segments = await prisma.flightSegment.findMany({
    where: { productId: flight.productId },
    orderBy: { seq: 'asc' },
    select: { departureAirport: true, arrivalAirport: true },
  });
  if (segments.length === 0) {
    bad('precondition', `no legs for ${flight.product.slug}`);
    return;
  }

  const slug = flight.product.slug;
  const from = segments[0]!.departureAirport.trim().toUpperCase();
  const to = segments[segments.length - 1]!.arrivalAirport.trim().toUpperCase();
  if (!to || to.length !== 3) {
    bad('precondition', `cannot resolve a destination for ${slug} (from=${from})`);
    return;
  }
  const ticketType = await prisma.ticketType.findFirst({
    where: { product: { slug }, active: true, currency: 'EUR' },
    select: { currency: true },
  });
  if (!ticketType) {
    bad('precondition', `no active ticket type for ${slug}`);
    return;
  }

  const serviceDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const query: LiveRateQuery = {
    slug,
    category: 'FLIGHT',
    serviceDate,
    quantity: 1,
    currency: ticketType.currency,
  };

  console.log(`\nwarming ${from} -> ${to} for ${slug} on ${serviceDate} (${ticketType.currency})`);

  // Read BEFORE warming. This must be empty, or the cache is being populated by
  // something other than the warmer and the test proves nothing.
  const before = await liveRates.resolve(query, 'search');
  if (before.quote !== null) {
    bad('cold read', `expected no quote before warming, got ${JSON.stringify(before.quote)}`);
  } else {
    ok('cold read', 'null (falls back to seeded price)');
  }

  const warmed = await warmTrvlRoute({ ...query, from, to });
  if (!warmed) bad('warm', 'warmer returned false');
  else ok('warm', 'wrote cache entry');

  // Read AFTER warming, through the resolver — the same path search uses.
  const after = await liveRates.resolve(query, 'search');
  if (after.quote === null) {
    bad('warm read', 'resolver still returns null after a successful warm');
    return;
  }

  ok('warm read', {
    netPriceCents: after.quote.netPriceCents,
    currency: after.quote.currency,
    sourceId: after.quote.sourceId,
    fromCache: after.quote.fromCache,
    degraded: after.degraded,
  });

  if (after.quote.currency !== ticketType.currency) {
    bad('currency', `warmed ${after.quote.currency} but product sells ${ticketType.currency}`);
  }
  if (!Number.isInteger(after.quote.netPriceCents) || after.quote.netPriceCents <= 0) {
    bad('price', `expected a positive integer minor-unit amount, got ${after.quote.netPriceCents}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());