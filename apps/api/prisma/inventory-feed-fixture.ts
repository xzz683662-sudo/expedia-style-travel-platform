import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../src/lib/prisma';
import { FIXTURE_SOURCE, ingestFixtureRows } from '../src/modules/inventory-feed/scraper';

/**
 * ---------------------------------------------------------------------------
 * Offline fixture ingest — `pnpm inventory:fixture`
 * ---------------------------------------------------------------------------
 *
 * Loads a stored sample of Expedia-shaped hotel payloads and stages it in
 * `ScrapedInventory`. This is the "get some data into the database" step that
 * does NOT need the live Apify actor, which is the point: the actor's default
 * egress is Apify's shared residential pool and Expedia answers it with
 * `error: Too Many Requests` (re-probed 2026-07-10; the actor's own 30-day
 * success rate is 0.107%).
 *
 * What lands is **sample** data, labelled `fixture:...` so it is never mistaken
 * for a fetched row. It is staged only — nothing becomes sellable. Promote a
 * row through `/admin/inventory-feed` (or `promoteScrapedRow`) and it becomes a
 * `DRAFT` first-party product, which the existing search index picks up.
 *
 * Usage:
 *   pnpm inventory:fixture
 *   pnpm inventory:fixture -- --file=./prisma/fixtures/expedia-hotels.sample.json
 *   pnpm inventory:fixture -- --city=Amsterdam --checkIn=2026-11-15 --checkOut=2026-11-18
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

async function main(): Promise<void> {
  const file = resolve(__dirname, flag('file') ?? 'fixtures/expedia-hotels.sample.json');
  const city = flag('city') ?? 'Amsterdam';
  const checkIn = flag('checkIn');
  const checkOut = flag('checkOut');

  console.log(`══ Inventory feed fixture ingest ══`);
  console.log(`file: ${file}`);

  let rows: unknown[];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error(`  ✗ could not read the fixture: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const summary = await ingestFixtureRows({ rows, cityHint: city, checkIn, checkOut });

  console.log(`  source:   ${summary.source}`);
  console.log(`  fetched:  ${summary.fetched}`);
  console.log(`  inserted: ${summary.inserted}`);
  console.log(`  updated:  ${summary.updated}`);
  console.log(`  skipped:  ${summary.skipped}  (rows with no id or no name — never guessed)`);

  // Read back, because `ingestFixtureRows` returns what it *attempted*. The
  // database is the only honest witness that the rows are really there.
  const staged = await prisma.scrapedInventory.count({ where: { source: FIXTURE_SOURCE } });
  const byStatus = await prisma.scrapedInventory.groupBy({
    by: ['status'],
    where: { source: FIXTURE_SOURCE },
    _count: { _all: true },
  });
  console.log(`\n  staged rows for ${FIXTURE_SOURCE}: ${staged}`);
  for (const bucket of byStatus) console.log(`    ${bucket.status}: ${bucket._count._all}`);

  const [products, ticketTypes] = await Promise.all([prisma.product.count(), prisma.ticketType.count()]);
  console.log(`  catalogue after staging: ${products} products, ${ticketTypes} ticket types (staging writes neither)`);
  console.log(`\nNext: open /admin/inventory-feed (needs INVENTORY_FEED_ENABLED=true) and promote a row.`);
}

main()
  .catch((error: unknown) => {
    console.error('FIXTURE INGEST FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
