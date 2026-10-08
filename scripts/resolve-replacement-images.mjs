/**
 * Resolves AND verifies replacement images from Wikipedia.
 *
 * Two lessons are baked in:
 *   1. Never hand-write a Wikimedia thumb URL — the host, hash path and width
 *      segments must match what the API issued (`thumb.wikimedia.org`, not
 *      `upload.wikimedia.org`). Hand-built ones 400.
 *   2. Verify before use. The whole reason this script exists is that the
 *      previous image set was never checked and 13 of 61 had 404'd.
 *
 * Prints the final URL for each slot so it can be pasted into the seed.
 *
 *   node scripts/resolve-replacement-images.mjs
 */
const UA = 'EasyTripSeed/1.0 (seed image resolution)';
const WIDTH = 1280;

/** slot -> Wikipedia article whose lead image illustrates it. */
const SLOTS = {
  // City hero images
  bath: 'Bath, Somerset',
  lyon: 'Lyon',
  florence: 'Florence',
  madrid: 'Madrid',
  zurich: 'Zurich',
  interlaken: 'Interlaken',
  vienna: 'Vienna',
  porto: 'Porto',
  // Product gallery subjects (replacing dead links whose alt text named these)
  tower_of_london: 'Tower of London',
  uffizi: 'Uffizi',
  sagrada_familia: 'Sagrada Família',
  los_angeles: 'Los Angeles',
  miami_beach: 'Miami Beach',
};

async function head(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    return { status: response.status, type: response.headers.get('content-type') ?? '' };
  } catch (error) {
    return { status: 0, type: '', error: error.message };
  }
}

/** Rewrites the width segment of an API-issued thumb URL, keeping host + query. */
function resize(url, width) {
  return url.replace(/\/(\d+)px-/, `/${width}px-`);
}

async function resolve(title) {
  const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!response.ok) return { error: `summary ${response.status}` };
  const json = await response.json();
  const original = json.originalimage?.source;
  const thumb = json.thumbnail?.source;
  if (!original && !thumb) return { error: 'no lead image' };
  return { original, thumb, article: json.title };
}

const resolved = {};
let failures = 0;

for (const [slot, title] of Object.entries(SLOTS)) {
  const result = await resolve(title);
  if (result.error) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${slot.padEnd(17)} ${result.error}`);
    continue;
  }

  // Prefer a resized thumbnail; fall back to the original only if it is a thumb.
  const candidates = [result.thumb ? resize(result.thumb, WIDTH) : null, result.thumb, result.original].filter(Boolean);

  let chosen = null;
  for (const candidate of candidates) {
    const check = await head(candidate);
    if (check.status === 200 && check.type.startsWith('image/')) {
      chosen = { url: candidate, size: Number(check.type.split('=')[1] ?? 0) || null, type: check.type };
      break;
    }
  }

  if (!chosen) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${slot.padEnd(17)} no candidate answered 200`);
    continue;
  }

  resolved[slot] = chosen.url;
  console.log(`  \x1b[32m✓\x1b[0m ${slot.padEnd(17)} ${chosen.type.replace(/;.*/, '')}`);
  console.log(`      ${chosen.url}`);
}

console.log(`\n${failures === 0 ? '\x1b[32mall resolved & verified\x1b[0m' : `\x1b[31m${failures} unresolved\x1b[0m`}`);
console.log('\nJSON:');
console.log(JSON.stringify(resolved, null, 2));
process.exitCode = failures === 0 ? 0 : 1;
