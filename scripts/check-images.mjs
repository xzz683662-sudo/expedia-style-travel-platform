import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'node:fs';

/**
 * Verifies every image URL the seed writes.
 *
 * The seed is the only place these URLs live, and nothing ever requested them —
 * so a typo'd Unsplash id stayed invisible until a human looked at the homepage
 * and saw a broken-image icon. This fetches each one and reports the status.
 *
 *   node scripts/check-images.mjs
 *
 * Exits non-zero when any URL fails, so it is usable as a gate.
 */

const ROOT = resolve(import.meta.dirname, '..');

function seedFiles() {
  return globSync('apps/api/prisma/*.ts', { cwd: ROOT }).map((file) => resolve(ROOT, file));
}

/**
 * Two shapes have to be found, because the seed writes images two ways:
 *   - an inline URL in `heroImageUrl` / `{ url: '...' }`
 *   - a bare id in an image pool (`{ id: 'photo-…', alt: '…' }`) that a helper
 *     turns into a URL at runtime
 * A template placeholder (`${id}`) is not a URL and must not be reported.
 */
const INLINE_RE = /https:\/\/(?:images\.unsplash\.com|thumb\.wikimedia\.org|upload\.wikimedia\.org)\/[^'"\s$]+/g;
const POOL_ID_RE = /id:\s*'(photo-[A-Za-z0-9\-_]+)'/g;

/** Inline urls are trimmed of their query; pool ids become the canonical URL. */
function normalise(url) {
  return url.split('?')[0];
}

function fromPoolId(id) {
  return `https://images.unsplash.com/${id}`;
}

const found = new Map(); // url -> Set<file:line>
for (const file of seedFiles()) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, index) => {
    const where = `${file.replace(`${ROOT}/`, '')}:${index + 1}`;

    const collect = (url) => {
      if (!found.has(url)) found.set(url, new Set());
      found.get(url).add(where);
    };

    for (const match of line.match(INLINE_RE) ?? []) collect(normalise(match));
    for (const match of line.matchAll(POOL_ID_RE)) collect(fromPoolId(match[1]));
  });
}

console.log(`checking ${found.size} unique image URL(s) from the seed\n`);

const failures = [];

async function check(url) {
  try {
    const response = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'EasyTripSeed/1.0' } });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, ok: response.ok && type.startsWith('image/'), type };
  } catch (error) {
    return { status: 0, ok: false, error: error.message };
  }
}

const results = await Promise.all([...found.keys()].map(async (url) => [url, await check(url)]));

for (const [url, result] of results.sort((a, b) => Number(a[1].ok) - Number(b[1].ok))) {
  const where = [...found.get(url)].join(', ');
  if (result.ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${result.status} ${url}`);
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${result.status}${result.error ? ` (${result.error})` : ''} ${url}`);
    console.log(`      used by ${where}`);
    failures.push({ url, where });
  }
}

console.log(`\n${failures.length === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m — ${found.size - failures.length}/${found.size} reachable`);

if (failures.length > 0) {
  console.log('\nReplacements must be verified with this script before use:');
  for (const failure of failures) console.log(`  - ${failure.url}`);
}

process.exitCode = failures.length === 0 ? 0 : 1;
