import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normaliseApifyRow, stripPii, type StagedRow } from '../src/modules/inventory-feed/scraper';

/**
 * Offline contract gate for the inventory feed — `pnpm inventory:contract`.
 *
 * Runs with no network and no database, like `supply:contract`. Its job is to
 * make the load-bearing rules *executable* rather than aspirational:
 *
 *   1. **Blast radius.** The ingest module must not import `pricing/`,
 *      `inventory/` or `booking/`, and must not mention a sellable money field.
 *      A scraped price reaching `TicketType.basePriceCents` is the failure this
 *      whole design exists to prevent, so it is asserted, not documented.
 *   2. **PII.** Reviewer identity is stripped before a payload can be stored.
 *   3. **Mapping.** The tolerant normaliser reads a plausible row and refuses an
 *      unusable one (no id / no name) instead of inventing a value.
 *
 * A static read of the source is a blunt instrument, but it is exactly the kind
 * of bluntness that catches the regression: the dangerous change is an import
 * statement, and an import statement is a string.
 */

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function source(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), 'utf8');
}

/**
 * Removes comments before the identifier checks.
 *
 * Without this the guard would fire on the module's own doc-comment — which
 * explains *why* `basePriceCents` must not be written — and the fix would be to
 * stop documenting the rule, which is exactly backwards.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('══ Inventory feed contract ══');

// ---------------------------------------------------------------------------
// 1. Blast radius
// ---------------------------------------------------------------------------
console.log('\nBlast radius (ingest must not touch the sellable path)');

const scraper = stripComments(source('modules/inventory-feed/scraper.ts'));
const promote = stripComments(source('modules/inventory-feed/promote.ts'));

/** Matches an import of one of the forbidden sibling domains. */
const forbiddenImport = /from\s+['"][^'"]*modules\/(pricing|inventory|booking)[^'"]*['"]/;

for (const [label, text] of [['scraper.ts', scraper], ['promote.ts', promote]] as const) {
  check(`${label} does not import pricing/inventory/booking`, !forbiddenImport.test(text));
}

// The ingest module must never name a field the booking path prices from.
for (const forbidden of ['basePriceCents', 'InventoryRecord', 'placeHold', 'computeQuote']) {
  check(`scraper.ts never references \`${forbidden}\``, !scraper.includes(forbidden));
}

// It writes exactly one table.
check(
  'scraper.ts writes only scrapedInventory',
  /prisma\.scrapedInventory\.(create|update|updateMany)/.test(scraper) &&
    !/prisma\.(product|ticketType|inventoryRecord)\./.test(scraper),
);

// ---------------------------------------------------------------------------
// 2. PII
// ---------------------------------------------------------------------------
console.log('\nPII stripping');

const withPii = {
  id: '1',
  name: 'Hotel Example',
  reviews: [{ reviewer: 'Jane Doe', email: 'jane@example.com', phone: '555', rating: 5, text: 'Great', date: '2026-01-01' }],
  contact: { author: 'Ops', email: 'ops@example.com' },
};

const stripped = stripPii(withPii) as any;
const review = stripped.reviews?.[0] ?? {};

check('hotel name survives (property data, not personal data)', stripped.name === 'Hotel Example');
check('reviewer name is removed', !('reviewer' in review));
check('review email is removed', !('email' in review));
check('review phone is removed', !('phone' in review));
check('review rating is kept', review.rating === 5);
check('review text is kept', review.text === 'Great');
check('nested author is removed', !stripped.contact || !('author' in stripped.contact));
check('nested email is removed', !stripped.contact || !('email' in stripped.contact));

// ---------------------------------------------------------------------------
// 3. Mapping
// ---------------------------------------------------------------------------
console.log('\nRow mapping (tolerant, but never invents a value)');

const ctx = { source: 'apify:test', runId: 'run-1', cityHint: 'Amsterdam' };

const good = normaliseApifyRow(
  {
    id: '12345',
    name: 'Grand Hotel',
    starRating: 4.2,
    latitude: 52.37,
    longitude: 4.89,
    countryCode: 'nl',
    price: { amount: 199.99, currency: 'eur' },
  },
  ctx,
);

check('a usable row is staged', good !== null);
check('externalId is read', good?.externalId === '12345');
check('name is read', good?.name === 'Grand Hotel');
check('price is integer minor units', good?.priceCents === 19999);
check('currency is normalised to 3 upper-case chars', good?.currency === 'EUR');
check('countryCode is normalised to 2 upper-case chars', good?.countryCode === 'NL');
check('rawPriceText preserves the original string', good?.rawPriceText === '199.99');
check('city hint fills citySlug', good?.citySlug === 'amsterdam');
check('staged row carries a raw payload', good !== null && typeof good.raw === 'object');

check('a row with no externalId is refused', normaliseApifyRow({ name: 'No id' }, ctx) === null);
check('a row with no name is refused', normaliseApifyRow({ id: '9' }, ctx) === null);

// A scraped price must not appear under a sellable key.
check('staged row exposes no basePriceCents', good !== null && !('basePriceCents' in (good as unknown as Record<string, unknown>)));

// ---------------------------------------------------------------------------
// 4. Offline fixture path
// ---------------------------------------------------------------------------
// The live actor is 429-throttled by default, so the staging → promote → search
// chain would otherwise be unprovable. These assertions keep the offline dataset
// honest and make sure the fixture path stages through the same normaliser the
// live path uses — a fixture that drifted from production would prove nothing.
console.log('\nOffline fixture ingest (the pipeline without a live upstream)');

check('scraper.ts exposes the offline ingest entry point', /export async function ingestFixtureRows/.test(scraper));

const fixturePath = resolve(ROOT, 'prisma/fixtures/expedia-hotels.sample.json');
check('fixture dataset exists', existsSync(fixturePath));

if (existsSync(fixturePath)) {
  const fixtureRows = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown[];
  const normalised = fixtureRows
    .map((row) => normaliseApifyRow(row, { source: 'fixture:contract', runId: null, cityHint: 'Amsterdam' }))
    .filter((row): row is StagedRow => row !== null);

  check('the fixture yields usable rows', normalised.length >= 3, `${normalised.length} usable of ${fixtureRows.length}`);
  check(
    'rows with no id or no name are skipped, never invented',
    normalised.length < fixtureRows.length,
    `${fixtureRows.length - normalised.length} skipped of ${fixtureRows.length}`,
  );
  check(
    'the fixture proves reviewer PII is stripped',
    !JSON.stringify(normalised.map((row) => row.raw)).includes('jane.doe@example.com'),
  );
  check(
    'fixture rows expose no sellable price key',
    normalised.every((row) => !('basePriceCents' in (row as unknown as Record<string, unknown>))),
  );
  check(
    'fixture prices are integer minor units',
    normalised.some((row) => Number.isInteger(row.priceCents) && (row.priceCents ?? 0) > 0),
  );
}

// ---------------------------------------------------------------------------
// 5. Positioning record
// ---------------------------------------------------------------------------
console.log('\nPositioning decision recorded');
const adr = resolve(ROOT, '../../docs/adr/0001-inventory-feed-positioning.md');
check('ADR-0001 exists', existsSync(adr));

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${checks - failures}/${checks} checks`);
if (failures > 0) process.exitCode = 1;
