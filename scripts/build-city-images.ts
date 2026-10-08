/**
 * ---------------------------------------------------------------------------
 * Build the per-city image pool
 * ---------------------------------------------------------------------------
 *
 * Generates `apps/api/prisma/city-images.ts` — a verified list of real, topical
 * photographs for every city in the catalogue.
 *
 * Why this file exists
 * --------------------
 * The catalogue generator used to pick a product's photo from a *global* pool
 * of 3–4 images per category. With 230 products that put the same Rome
 * Colosseum photograph on 30 different cards, and it put a photograph of one
 * city on a product sold in another. Both are visible defects on the storefront.
 *
 * The fix is a pool *per city*, so a Venice product carries a Venice
 * photograph, and each product within a city takes a different one. That needs
 * far more images than any hand-written list can hold, and they must be real,
 * free-to-use and reachable — so they are resolved from Wikimedia Commons and
 * checked here rather than guessed.
 *
 * Relevance comes from the city's Wikipedia article: the files that article
 * actually illustrates itself with are the city's own landmarks. Quality comes
 * from the filters below, which drop maps, coats of arms, engravings, plans and
 * extreme panoramas, and reject anything narrower than a landscape card or
 * smaller than 1200px.
 *
 * The output is committed. This script is a *build* step, not a runtime
 * dependency: re-running it is only needed when a city is added or a URL rots.
 *
 *   pnpm tsx scripts/build-city-images.ts --measure   # report yield, write nothing
 *   pnpm tsx scripts/build-city-images.ts             # write city-images.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CITIES } from '../apps/api/prisma/seed-cities';

const UA = 'EasyTrip seed image builder (https://github.com/easytrip; dev@easytrip.test)';

/** Images to keep per city. Must cover that city's product count for uniqueness. */
const PER_CITY = 18;

/** Cities whose English Wikipedia article is not simply the display name. */
const WIKI_TITLE: Record<string, string> = {
  'new-york': 'New York City',
  'los-angeles': 'Los Angeles',
  'san-francisco': 'San Francisco',
  'las-vegas': 'Las Vegas',
  'singapore-city': 'Singapore',
  bath: 'Bath, Somerset',
  zurich: 'Zürich',
  interlaken: 'Interlaken',
  seville: 'Seville',
};

/**
 * File-name fragments that mean "this is not a photograph of the city".
 *
 * Rejecting on the *file name* rather than the image content is imperfect, but
 * every one of these appeared in a sample of real article results, and a
 * rejected candidate costs nothing because the pool only needs 18 entries.
 */
const REJECT = [
  'map', 'flag', 'coat of arms', 'coat_of_arms', 'coa ', 'logotype', 'logo',
  'diagram', 'plan of', 'seal', 'banner', 'relief', 'location', 'locator',
  'blank map', 'svg',
  'metro', 'u-bahn', 'ubahn', 'bus ', 'bus_', 'tram', 'tramway', 'railway',
  'railway station', 'station ', 'airport', 'aeroplane', 'airplane', 'aircraft',
  'lufthansa', 'locomotive', 'train',
  'panorama', 'panoramic', 'stitch',
  'engraving', 'lithograph', 'etching', 'woodcut', 'oil on canvas', 'painting',
  'google art project', 'van der hagen', 'veduta', 'watercolour', 'watercolor',
  'drawing', 'poster', 'stamp', 'coin', 'banknote', 'manuscript',
  'graffiti', 'screenshot', 'signature',
  // Amateur-upload giveaways: a shared album name, a raw camera frame, or a
  // stock-numbered archive scan. Sorted by resolution below, so these are the
  // noisy tail that a landmark photograph does not need.
  'panoramio', 'cropped', 'img ', 'img_', 'dsc', 'dscf', 'imgp', 'p1010',
  'photo of the day', 'scan', 'copy of', 'map of',
];

/**
 * Minimum original size for a candidate, in megapixels.
 *
 * A deliberate photograph of a landmark is almost always a large one; a
 * phone snapshot is not. Because candidates are ranked by resolution and only
 * the best `PER_CITY` survive, this threshold is what turns "files an article
 * happens to link" into "photographs worth putting on a card".
 */
const MIN_MEGAPIXELS = 4;

/** Reject anything that is clearly a person-in-distress or conflict photo. */
const REJECT_CONTENT = [
  'dead', 'corpse', 'funeral', 'protest', 'riot', 'police', 'army', 'military',
  'war ', 'fire ', 'accident', 'disaster', 'wreck', 'flood damage', 'rubble',
];

interface Candidate {
  title: string;
  url: string;
  width: number;
  height: number;
}

function isRejected(title: string): boolean {
  const t = title.toLowerCase();
  return [...REJECT, ...REJECT_CONTENT].some((fragment) => t.includes(fragment));
}

function aspectOk(c: Candidate): boolean {
  const ratio = c.width / c.height;
  return (
    c.width >= 1200 &&
    c.height >= 700 &&
    c.width <= 12000 &&
    ratio >= 1.2 &&
    ratio <= 2.0 &&
    (c.width * c.height) / 1e6 >= MIN_MEGAPIXELS
  );
}

async function jsonFetch(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** File titles used by the city's English Wikipedia article, in article order. */
async function articleFileTitles(wikiTitle: string): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', titles: wikiTitle, prop: 'images', imlimit: '500',
    redirects: '1',
  });
  const json = await jsonFetch(`https://en.wikipedia.org/w/api.php?${params}`);
  const titles: string[] = [];
  for (const page of Object.values<any>(json?.query?.pages ?? {})) {
    for (const img of page.images ?? []) {
      if (/\.(jpe?g|png)$/i.test(img.title)) titles.push(img.title);
    }
  }
  return titles;
}

/** Resolves Commons file titles to 1200px thumbnails plus original dimensions. */
async function resolveThumbs(titles: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let i = 0; i < titles.length; i += 40) {
    const chunk = titles.slice(i, i + 40);
    const params = new URLSearchParams({
      action: 'query', format: 'json', titles: chunk.join('|'),
      prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '1600',
    });
    const json = await jsonFetch(`https://commons.wikimedia.org/w/api.php?${params}`);
    for (const page of Object.values<any>(json?.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      if (!['image/jpeg', 'image/png'].includes(info.mime)) continue;
      out.push({
        title: page.title,
        // The API hands back the canonical CDN host; hand-built thumb URLs 400.
        url: info.thumburl,
        width: info.width,
        height: info.height,
      });
    }
  }
  return out;
}

/** A `HEAD` is not enough — Commons answers `HEAD` differently from `GET`. */
async function urlIsReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'user-agent': UA, range: 'bytes=0-2047' } });
    if (!res.ok) return false;
    return (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

async function poolForCity(slug: string, name: string): Promise<Candidate[]> {
  const wikiTitle = WIKI_TITLE[slug] ?? name;
  const titles = await articleFileTitles(wikiTitle);
  const resolved = await resolveThumbs(titles);

  const seen = new Set<string>();
  const candidates = resolved
    .filter((c) => {
      if (isRejected(c.title)) return false;
      if (!aspectOk(c)) return false;
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    })
    // Largest originals first. A dedicated architectural photograph is usually
    // far larger than a passer-by's snapshot, so this is a cheap, stable proxy
    // for quality that does not depend on guessing a photographer's habits.
    .sort((a, b) => b.width * b.height - a.width * a.height);

  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (kept.length >= PER_CITY) break;
    if (await urlIsReachable(candidate.url)) kept.push(candidate);
  }
  return kept;
}

function altFromTitle(title: string, city: string): string {
  const cleaned = title
    .replace(/^File:/, '')
    .replace(/\.[a-z]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned} — ${city}`;
}

async function main(): Promise<void> {
  const measure = process.argv.includes('--measure');
  const pools: Record<string, { url: string; altText: string }[]> = {};
  const shortfalls: string[] = [];

  for (const city of CITIES) {
    const pool = await poolForCity(city.slug, city.name);
    pools[city.slug] = pool.map((c) => ({ url: c.url, altText: altFromTitle(c.title, city.name) }));
    const flag = pool.length < PER_CITY ? ' ⚠ SHORT' : '';
    console.log(`${city.slug.padEnd(16)} ${String(pool.length).padStart(2)}/${PER_CITY}${flag}`);
    if (measure) {
      for (const c of pool) console.log(`      ${c.title.replace('File:', '')}`);
    }
    if (pool.length < PER_CITY) shortfalls.push(`${city.slug} (${pool.length})`);
  }

  const total = Object.values(pools).reduce((n, p) => n + p.length, 0);
  const unique = new Set(Object.values(pools).flat().map((p) => p.url));
  console.log(`\n${CITIES.length} cities, ${total} images, ${unique.size} unique URLs`);
  if (shortfalls.length) console.log(`short: ${shortfalls.join(', ')}`);

  if (measure) {
    console.log('\n--measure: nothing written.');
    return;
  }

  const lines = Object.entries(pools).map(([slug, pool]) => {
    const entries = pool
      .map((p) => `    { url: '${p.url}', altText: ${JSON.stringify(p.altText)} },`)
      .join('\n');
    return `  '${slug}': [\n${entries}\n  ],`;
  });

  const body = `/**
 * ---------------------------------------------------------------------------
 * Per-city image pool — GENERATED, do not edit by hand
 * ---------------------------------------------------------------------------
 *
 * Produced by \`scripts/build-city-images.ts\`. Re-run it when a city is added to
 * \`seed-cities.ts\`, or when \`pnpm check:images\` reports a dead URL.
 *
 * Every entry is a real Wikimedia Commons thumbnail that answered HTTP 200 with
 * an image content-type at build time. They are illustrations of that city's own
 * Wikipedia article, which is what makes them topical: a Venice product shows
 * Venice, and every product in a city takes a different frame, so the
 * storefront never repeats a photograph on one screen.
 *
 * ${total} images across ${Object.keys(pools).length} cities.
 */

export interface CityImage {
  url: string;
  altText: string;
}

export const CITY_IMAGES: Record<string, CityImage[]> = {
${lines.join('\n')}
};

/** Cities with no imagery on file. A product there falls back to its category pool. */
export const CITIES_WITHOUT_IMAGES = ${JSON.stringify(
    Object.entries(pools)
      .filter(([, pool]) => pool.length === 0)
      .map(([slug]) => slug),
  )};
`;

  const target = resolve(import.meta.dirname, '../apps/api/prisma/city-images.ts');
  writeFileSync(target, body, 'utf8');
  console.log(`\nwrote ${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
