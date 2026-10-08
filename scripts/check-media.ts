/**
 * ---------------------------------------------------------------------------
 * Catalogue artwork gate — offline
 * ---------------------------------------------------------------------------
 *
 * Asserts the two properties the storefront depends on and no compiler can see:
 *
 *   1. **No product shares a photograph with another.** The catalogue used to
 *      draw from a pool of three or four images per category, which put one Rome
 *      Colosseum photograph on thirty cards and made the home page visibly
 *      repeat itself. That is a data defect, so it is checked as data.
 *   2. **Every product has at least one photograph.** A missing image renders as
 *      a grey box, which reads as a broken page rather than a missing asset.
 *
 * It reads the seed catalogue directly rather than the database, so it needs no
 * server, no network and no fixture, and it fails on the *source* of the defect
 * instead of the symptom.
 *
 *   pnpm check:media        (wired into `pnpm verify`)
 */

import { PRODUCTS } from '../apps/api/prisma/seed-products';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log('══ Catalogue artwork ══');

const usage = new Map<string, string[]>();
const withoutMedia: string[] = [];

for (const product of PRODUCTS) {
  const gallery = product.media ?? [];
  if (gallery.length === 0) withoutMedia.push(product.slug);
  for (const image of gallery) {
    if (!usage.has(image.url)) usage.set(image.url, []);
    usage.get(image.url)!.push(product.slug);
  }
}

const shared = [...usage.entries()]
  .filter(([, slugs]) => slugs.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

const rows = [...usage.values()].reduce((n, slugs) => n + slugs.length, 0);

console.log(`  ${PRODUCTS.length} products, ${rows} image slots, ${usage.size} distinct photographs`);

check('every product has at least one photograph', withoutMedia.length === 0, withoutMedia.slice(0, 8).join(', '));

check(
  'no photograph is used by more than one product',
  shared.length === 0,
  shared
    .slice(0, 8)
    .map(([url, slugs]) => `${url.slice(-40)} ×${slugs.length} (${slugs.slice(0, 3).join(', ')})`)
    .join('; '),
);

// A product's own gallery must not repeat a frame either — it is the same defect
// one level down, and two identical thumbnails sit side by side in the viewer.
const selfRepeating: string[] = [];
for (const product of PRODUCTS) {
  const gallery = (product.media ?? []).map((m) => m.url);
  if (new Set(gallery).size !== gallery.length) selfRepeating.push(product.slug);
}
check('no product repeats a photograph inside its own gallery', selfRepeating.length === 0, selfRepeating.slice(0, 8).join(', '));

if (failures > 0) {
  console.error(`\n${failures} artwork check(s) failed.`);
  console.error('Re-run `npx tsx scripts/build-photo-pools.ts` to grow the pools, then re-seed.');
  process.exit(1);
}

console.log('\nCatalogue artwork is unique.');
