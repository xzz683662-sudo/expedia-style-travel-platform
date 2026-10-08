/**
 * ---------------------------------------------------------------------------
 * Build the category photo pools
 * ---------------------------------------------------------------------------
 *
 * Generates `apps/api/prisma/photo-pools.ts` — a large, verified pool of real
 * photographs for each product category.
 *
 * Why this file exists
 * --------------------
 * `seed-global.ts` gave every generated product a photo from a pool of **three
 * or four** images per category. With 230 products that put one Rome
 * Colosseum photograph on 30 separate cards; the storefront's home page showed
 * the same picture several times over. The pools were simply far too small, and
 * the assignment (`hashed index`) could not avoid collisions even in principle.
 *
 * The pools below are resolved from Wikimedia Commons by *subject* — aircraft,
 * hotel rooms, ships, old towns, monuments, outdoor days — which keeps the
 * existing design intact: a flight still shows an aircraft, not a canal. What
 * changes is scale. The seed then hands each product the next unused image in
 * its category, so no two products can share one.
 *
 * Quality is enforced in three layers, because Commons is an open archive and a
 * naive relevance search returns maps, engravings and bus photographs:
 *   1. a file-name blocklist for things that are not photographs of the subject;
 *   2. a landscape, minimum-size, maximum-aspect filter, so a card crop works;
 *   3. a reachability check, since a URL that 404s would render as a grey box.
 *
 *   npx tsx scripts/build-photo-pools.ts --measure   # report yield, write nothing
 *   npx tsx scripts/build-photo-pools.ts             # write photo-pools.ts
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UA = 'EasyTrip seed image builder (dev@easytrip.test)';

/**
 * How many images to keep per category.
 *
 * Must exceed the number of products in that category, because `claimImage`
 * refuses to reuse one. The catalogue is sized from these numbers, not the
 * other way around: a pool this size is what a marketplace-scale catalogue
 * needs to give every listing its own photograph.
 */
const PER_CATEGORY = 900;

/**
 * Commons result pages to walk per query.
 *
 * One query returns a single page of results, and the filters below drop most
 * of it, so a single page per term saturates long before the pool is full. Each
 * extra page is one cheap JSON request against the open API.
 */
const PAGES_PER_QUERY = 6;

/**
 * Commons search terms per category.
 *
 * Several terms per category are used because a single query saturates:
 * Commons returns a fixed page of results and the filters below remove a large
 * share. Results are merged, de-duplicated and ranked before the pool is cut.
 *
 * The terms are deliberately *subjects that get photographed well* rather than
 * bare nouns. `market hall` returns other people's holiday snapshots and
 * restaurant signs; `medieval old town square` returns the square.
 */
const QUERIES: Record<string, string[]> = {
  flight: [
    'airliner cabin interior',
    'aircraft cabin business class',
    'airplane wing above clouds',
    'airport terminal departure hall',
    'airliner on apron sunset',
    'business class seat cabin',
    'airport departure lounge interior',
    'aircraft window view clouds',
    'airliner takeoff runway',
    'airplane cockpit flight deck',
    'airport jet bridge boarding',
    'airliner parked gate',
    'aircraft in flight sky',
    'airport check-in hall',
    'airline first class seat',
    'aeroplane landing approach',
    'aircraft fuselage closeup',
    'airline economy cabin seats',
    'airport runway markings',
    'airplane above clouds sunset',
    'airliner winglet sky',
    'airport gate waiting area',
    'private jet aircraft',
  ],
  hotel: [
    'hotel room interior',
    'hotel suite bedroom',
    'hotel lobby interior',
    'hotel swimming pool resort',
    'resort infinity pool',
    'hotel courtyard luxury',
    'hotel room sea view',
    'boutique hotel bedroom',
    'hotel reception desk',
    'hotel breakfast room',
    'hotel bathroom marble',
    'resort beach bungalow',
    'hotel rooftop terrace',
    'hotel spa interior',
    'hotel double room bed',
    'hotel garden terrace',
    'hotel room balcony view',
    'luxury bedroom interior',
    'hotel corridor interior',
    'hotel restaurant dining room',
    'hotel bar lounge interior',
    'apartment living room interior',
  ],
  cruise: [
    'cruise ship sea',
    'river cruise ship',
    'yacht marina harbour',
    'ferry boat harbour',
    'sailing ship sea',
    'cruise liner ocean',
    'boat pier sea',
    'ship deck sea view',
    'cruise ship port',
    'catamaran sail sea',
    'cruise ship bow sea',
    'port city waterfront',
    'wooden boat harbour',
    'sailing yacht sea sunset',
    'river boat bank',
    'marina boats moored',
  ],
  guide: [
    'medieval old town square',
    'historic city centre street',
    'cobblestone street old town',
    'piazza fountain italy',
    'canal houses amsterdam',
    'old town rooftops',
    'venice canal gondola',
    'santorini white houses',
    'prague old town square',
    'florence cathedral view',
    'narrow street old town',
    'european city street cafe',
    'town square fountain europe',
    'historic square buildings',
    'old town alley daylight',
    'city street pedestrians',
    'harbour town waterfront',
    'city centre pedestrian zone',
    'market square europe',
    'small town main street',
    'arcaded street europe',
    'quarter historic buildings',
    'street cafe tables europe',
    'town hall square europe',
    'half timbered houses street',
    'city bridge over river',
    'gateway arch old town',
    'staircase old town street',
  ],
  landmark: [
    'gothic cathedral facade',
    'castle on hill',
    'basilica dome',
    'palace exterior garden',
    'city tower old town',
    'colosseum roman amphitheatre',
    'eiffel tower paris',
    'temple pagoda japan',
    'famous bridge city night',
    'monument skyline sunset',
    'church facade europe',
    'lighthouse coast',
    'opera house building',
    'museum building entrance',
    'chateau castle france',
    'abbey monastery building',
    'obelisk monument square',
    'ancient ruins columns',
    'city gate historic',
    'theatre building facade',
    'fortress walls',
    'botanical garden greenhouse',
    'clock tower building',
    'dome church roof',
    'castle courtyard',
    'roman arch monument',
    'baroque church interior',
    'gallery art museum room',
    'royal palace facade',
    'city walls ramparts',
    'stained glass window church',
    'civic building colonnade',
  ],
  activity: [
    'hiking trail mountains',
    'vineyard landscape',
    'beach coastline aerial',
    'hot air balloon landscape',
    'national park landscape',
    'mountain lake reflection',
    'sailing boat turquoise water',
    'sunrise mountain range',
    'waterfall forest trail',
    'countryside road fields',
    'forest path sunlight',
    'coast cliff sea view',
    'olive grove terraces',
    'lavender field landscape',
    'snowy mountain peaks',
    'river valley countryside',
    'desert dunes sunset',
    'island beach turquoise',
    'lake pier mountains',
    'meadow wildflowers hills',
    'hiking path mountain ridge',
    'river rapids rocks',
    'sunset over sea horizon',
    'pine forest mountains',
    'green valley village',
    'boat on alpine lake',
    'cycling road countryside',
    'glacier mountain ice',
  ],
};

/**
 * Maps the human-readable query keys above onto the real `ProductType` enum.
 *
 * The generated file is consumed as `PHOTO_POOLS[ProductType]`, so the keys
 * **must** be the enum values. Emitting the lower-case query names instead
 * type-checked fine (a `Record<ProductType, …>` annotation does not verify its
 * literal keys) and then failed at runtime with `undefined.length`.
 */
const POOL_KEY: Record<string, string> = {
  flight: 'FLIGHT',
  hotel: 'HOTEL_ROOM',
  cruise: 'CRUISE',
  guide: 'GUIDED_TOUR',
  landmark: 'ATTRACTION_TICKET',
  activity: 'ACTIVITY',
};

/**
 * File-name fragments that mean "this is not a photograph of the subject".
 *
 * Every entry here was added because it actually appeared in a real result
 * sample: catalogue-book page scans under `activity`, a sentinel satellite
 * image under a city, transit photographs under `landmark`. A rejected
 * candidate costs nothing — the pool only needs a hundred good frames.
 */
const REJECT = [
  'map', 'flag', 'coat of arms', 'coat_of_arms', 'coa ', 'logotype', 'logo',
  'diagram', 'plan of', 'seal', 'banner', 'relief', 'location', 'locator', 'svg',
  'metro', 'u-bahn', 'ubahn', 'bus ', 'bus_', 'tram', 'tramway', 'locomotive',
  'graffiti', 'screenshot', 'signature', 'panoramio', 'cropped', 'img ', 'img_',
  'dsc', 'dscf', 'imgp', 'scan', 'drawing', 'engraving', 'lithograph', 'etching',
  'woodcut', 'oil on canvas', 'poster', 'stamp', 'coin', 'banknote', 'manuscript',
  'demolition', 'construction site', 'ruins of', 'abandoned',
  // Book and atlas plates. A scan of a 19th-century catalogue page is a valid
  // Commons file and a completely unacceptable product photograph.
  'text page', 'page to', 'plate from', 'from the book', 'ia dr ', '(ia ',
  'atlas', 'carte', 'mapa', 'karte', 'map of', 'city map',
  'sentinel', 'satellite image', 'landsat', 'aerial photograph of the city of',
  'sign of', 'restaurant sign', 'menu', 'logo of',
  // Print-making and archive-scan giveaways. `lith` catches `lith.` and
  // `lithograph`; `lccn` and `panosphere` are Library of Congress scans and
  // 360-degree composites, neither of which is a photograph of a place.
  'lith', 'lccn', 'panosphere', 'panoramic view', 'screen capture',
];

const REJECT_CONTENT = [
  'dead', 'corpse', 'funeral', 'protest', 'riot', 'police', 'army', 'military',
  'war ', 'fire ', 'accident', 'disaster', 'wreck', 'rubble',
];

/** Minimum original size, in megapixels. A deliberate photograph is a large one. */
/**
 * Minimum original size for a candidate, in megapixels.
 *
 * A deliberate photograph of a landmark is almost always a large one; a phone
 * snapshot is not. Because candidates are ranked by resolution and only the best
 * `PER_CATEGORY` survive, this threshold is what turns "files a search happens
 * to return" into "photographs worth putting on a card".
 *
 * A card renders the image at roughly 400x250 CSS pixels, so even 2 MP is a
 * large amount of headroom for a 2x screen; the floor exists to reject phone
 * snapshots and archive scans, not to chase sharpness.
 */
const MIN_MEGAPIXELS = 2;

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
    c.width <= 14000 &&
    ratio >= 1.2 &&
    ratio <= 2.0 &&
    (c.width * c.height) / 1e6 >= MIN_MEGAPIXELS
  );
}

/**
 * Politeness for a public API.
 *
 * Wikimedia rate-limits anonymous clients, and this build makes hundreds of
 * requests in a burst. Without a pause and a retry the later categories came
 * back with **zero** candidates — the API had started answering `429` and the
 * build treated it as "no results", which is how a pool can silently end up
 * empty. `Retry-After` is honoured when the API sends it.
 */
const REQUEST_GAP_MS = 120;
let lastRequestAt = 0;

async function politePause(): Promise<void> {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function jsonFetch(url: string, attempt = 0): Promise<any> {
  await politePause();
  const res = await fetch(url, { headers: { 'user-agent': UA } });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`HTTP ${res.status} for ${url} after ${attempt} retries`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    return jsonFetch(url, attempt + 1);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Candidates for one query term, walking several result pages.
 *
 * Commons caps a single search response, so one request per term stopped
 * yielding long before the pool was full — the pool cannot be grown by asking
 * for a bigger page, only by following the API's own `gsroffset` cursor. Each
 * page is a cheap JSON request against the open API; a failure part-way through
 * is absorbed so one flaky page does not lose the term's earlier pages.
 */
async function candidatesFor(query: string): Promise<Candidate[]> {
  const out: Candidate[] = [];

  for (let page = 0; page < PAGES_PER_QUERY; page += 1) {
    const params = new URLSearchParams({
      action: 'query', format: 'json',
      generator: 'search', gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: '6', gsrlimit: '100',
      gsroffset: String(page * 100),
      prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '1600',
    });

    let json: any;
    try {
      json = await jsonFetch(`https://commons.wikimedia.org/w/api.php?${params}`);
    } catch {
      break;
    }

    const pages = Object.values<any>(json?.query?.pages ?? {});
    if (pages.length === 0) break;

    for (const entry of pages) {
      const info = entry.imageinfo?.[0];
      if (!info || !['image/jpeg', 'image/png'].includes(info.mime)) continue;
      out.push({ title: entry.title, url: info.thumburl, width: info.width, height: info.height });
    }

    // A short page is the last page; the API says so by omitting the cursor.
    if (!json?.continue?.gsroffset || pages.length < 100) break;
  }

  return out;
}

/** A `HEAD` is answered differently from a `GET`; ask for the first bytes. */
async function urlIsReachable(url: string, attempt = 0): Promise<boolean> {
  try {
    await politePause();
    const res = await fetch(url, { method: 'GET', headers: { 'user-agent': UA, range: 'bytes=0-2047' } });
    if (res.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      return urlIsReachable(url, attempt + 1);
    }
    if (!res.ok) return false;
    return (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

function altText(title: string, category: string): string {
  const cleaned = title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '')
    .replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${cleaned} (${category})`;
}

/**
 * Collapses a title to its subject so near-identical frames do not all ship.
 *
 * A batch upload puts dozens of frames of the same scene in the pool —
 * `Bahamas Cruise ship exterior June 2018 (2042)` and `(2059)` and `(2073)` are
 * one photograph taken several times. Publishing them all would reintroduce
 * exactly the repetition this file exists to remove, just at a larger scale, so
 * only the largest frame of each subject is kept.
 */
function subjectKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\.(jpe?g|png)$/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/[^a-z\u4e00-\u9fff]+/g, ' ')
    .trim();
}

/** Runs `worker` over `items` with a bounded number in flight at once. */
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<boolean>): Promise<boolean[]> {
  const results = new Array<boolean>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const measure = process.argv.includes('--measure');
  const pools: Record<string, { url: string; altText: string }[]> = {};
  const usedUrls = new Set<string>();

  for (const [category, queries] of Object.entries(QUERIES)) {
    const merged = new Map<string, Candidate>();
    for (const query of queries) {
      for (const c of await candidatesFor(query)) {
        if (isRejected(c.title)) continue;
        if (!aspectOk(c)) continue;
        if (usedUrls.has(c.url)) continue;
        if (!merged.has(c.url)) merged.set(c.url, c);
      }
    }

    // Largest originals first, then one frame per subject. A dedicated
    // architectural photograph is almost always far larger than a passer-by's
    // snapshot, which makes resolution a cheap, stable proxy for quality.
    const ranked = [...merged.values()].sort((a, b) => b.width * b.height - a.width * a.height);

    // One frame per subject, before the network check — the check is the
    // expensive part, so it must only run on candidates that could be kept.
    const subjects = new Set<string>();
    const shortlist: Candidate[] = [];
    for (const candidate of ranked) {
      if (shortlist.length >= PER_CATEGORY) break;
      const subject = subjectKey(candidate.title);
      if (subjects.has(subject)) continue;
      subjects.add(subject);
      shortlist.push(candidate);
    }

    // Reachability, with several requests in flight. Sequentially this is one
    // round-trip per candidate and dominates the whole build; the API is a
    // public read endpoint and a small amount of parallelism is polite.
    const reachable = await mapLimit(shortlist, 4, (candidate) => urlIsReachable(candidate.url));

    const kept: { url: string; altText: string }[] = [];
    shortlist.forEach((candidate, index) => {
      if (!reachable[index]) return;
      usedUrls.add(candidate.url);
      kept.push({ url: candidate.url, altText: altText(candidate.title, category) });
    });

    pools[category] = kept;
    console.log(`${POOL_KEY[category].padEnd(20)} ${String(kept.length).padStart(4)}/${PER_CATEGORY}  (from ${merged.size} candidates)`);

    if (measure) {
      for (const k of kept.slice(0, 12)) console.log(`      ${k.altText}`);
    }
  }

  const total = Object.values(pools).reduce((n, p) => n + p.length, 0);
  console.log(`\n${total} images across ${Object.keys(pools).length} categories`);

  if (measure) {
    console.log('\n--measure: nothing written.');
    return;
  }

  const body = `/**
 * ---------------------------------------------------------------------------
 * Category photo pools — GENERATED, do not edit by hand
 * ---------------------------------------------------------------------------
 *
 * Produced by \`scripts/build-photo-pools.ts\`. Re-run it when a pool runs dry
 * (\`pnpm check:media\` reports a duplicate) or when \`pnpm check:images\` reports a
 * dead URL.
 *
 * Every URL is a real Wikimedia Commons thumbnail that answered HTTP 200 with an
 * image content-type when this file was generated. Order is meaningful:
 * \`seed-global.ts\` walks each pool front to back and hands out one image per
 * product, so the only thing a duplicate would mean is that the pool is smaller
 * than the catalogue.
 *
 * ${total} images.
 */

import type { ProductType } from '@prisma/client';

export interface PooledImage {
  url: string;
  altText: string;
}

export const PHOTO_POOLS: Record<ProductType, PooledImage[]> = {
${Object.entries(pools)
    .map(([category, pool]) => {
      const entries = pool
        .map((p) => `    { url: '${p.url}', altText: ${JSON.stringify(p.altText)} },`)
        .join('\n');
      return `  ${POOL_KEY[category]}: [\n${entries}\n  ],`;
    })
    .join('\n')}
};
`;

  const target = resolve(import.meta.dirname, '../apps/api/prisma/photo-pools.ts');
  writeFileSync(target, body, 'utf8');
  console.log(`\nwrote ${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
