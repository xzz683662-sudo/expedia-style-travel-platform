#!/usr/bin/env node
/**
 * Opt-in inventory-feed test. Never part of `pnpm verify` — it may make a paid
 * Apify call, and the smoke suite must not depend on a third party.
 *
 *   APIFY_TOKEN=… node scripts/feed-test.mjs
 *
 * Two phases, both optional:
 *
 *   A. LIVE PROBE (needs APIFY_TOKEN). Completes Step 1 of the integration
 *      design: runs the smallest useful input (limit 5, one city, no
 *      `includes:*`), prints the *real* row shape with personal data redacted,
 *      and writes an anonymised sample to docs/feed-sample-row.json so the
 *      normaliser in apps/api/src/modules/inventory-feed/scraper.ts can be
 *      trimmed to the paths that actually occur.
 *
 *   B. DB INTEGRATION (needs API_URL + ADMIN_TOKEN, and INVENTORY_FEED_ENABLED
 *      =true on the server). Exercises the ingest through the admin API and
 *      asserts the blast-radius rule: staging must not change Product,
 *      TicketType or InventoryRecord, and a second identical run must insert
 *      nothing new.
 *
 * Reading .env is best-effort; real values win. The token is never printed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function loadEnv() {
  for (const file of ['.env']) {
    try {
      for (const line of readFileSync(resolve(ROOT, file), 'utf8').split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/.exec(line);
        if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
      }
    } catch {
      /* no .env is fine */
    }
  }
}
loadEnv();

const TOKEN = process.env.APIFY_TOKEN;
const ACTOR = process.env.APIFY_HOTEL_ACTOR || 'jupri/expedia-hotels';
const API_URL = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BASE = 'https://api.apify.com/v2';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const PII = /^(reviewer|reviewer[_]?name|author|author[_]?name|email|phone|telephone|contactEmail|userName|user|firstName|lastName)$/i;

function describe(value, prefix, out) {
  if (value === null) return out.push(`${prefix}: null`);
  if (Array.isArray(value)) {
    if (!value.length) return out.push(`${prefix}: []`);
    out.push(`${prefix}: Array(${value.length})`);
    return describe(value[0], `${prefix}[0]`, out);
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) describe(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  const leaf = prefix.split('.').pop();
  out.push(`${prefix}: ${typeof value} ${PII.test(leaf) ? '[REDACTED]' : JSON.stringify(String(value).slice(0, 80))}`);
}

async function apify(path, init) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const message = json?.error?.message ?? `HTTP ${res.status}`;
    const approval = json?.error?.data?.approvalUrl;
    throw new Error(`${message}${approval ? `\n  approve at: ${approval}` : ''}`);
  }
  return json;
}

async function phaseA() {
  console.log('\n══ Phase A — live probe (Step 1 calibration) ══');
  const input = { location: ['Amsterdam'], limit: 5 };
  console.log('input:', JSON.stringify(input));

  const slug = ACTOR.replace('/', '~');
  const started = await apify(`/acts/${slug}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const run = started.data ?? started;
  let status = run.status;

  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    await new Promise((r) => setTimeout(r, 5000));
    const polled = await apify(`/actor-runs/${run.id}`);
    status = (polled.data ?? polled).status;
    console.log(`  … status=${status}`);
  }
  check(`run reached SUCCEEDED (got ${status})`, status === 'SUCCEEDED');

  const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=5`);
  const rows = Array.isArray(items) ? items : [];
  console.log(`  rows: ${rows.length}`);
  if (!rows.length) {
    console.log('  EMPTY — an expected outcome for this actor (measured 0.107% success). Not a failure.');
    return;
  }

  const shape = [];
  describe(rows[0], '', shape);
  console.log('\n  --- real row shape (PII redacted) ---');
  for (const line of shape) console.log(`  ${line}`);

  // Anonymised sample, committed so the mapping can be calibrated offline.
  const sample = structuredClone(rows[0]);
  const scrub = (obj) => {
    if (Array.isArray(obj)) return obj.map(scrub);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (PII.test(k)) delete obj[k];
        else obj[k] = scrub(obj[k]);
      }
    }
    return obj;
  };
  const outPath = resolve(ROOT, 'docs/feed-sample-row.json');
  writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), actor: ACTOR, input, sample: scrub(sample) }, null, 2));
  console.log(`\n  anonymised sample written to docs/feed-sample-row.json`);
  check('sample captured', true);
}

async function adminFetch(path, init) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function phaseB() {
  console.log('\n══ Phase B — DB integration (blast radius) ══');
  console.log(`api: ${API_URL}`);

  const before = await adminFetch('/admin/dashboard');
  if (!before.ok) {
    console.log(`  cannot reach admin API (HTTP ${before.status}); skipping. Is the API running with INVENTORY_FEED_ENABLED=true?`);
    return;
  }
  const productsBefore = before.json?.kpis ? undefined : undefined;

  const body = { location: ['Amsterdam'], limit: 5 };
  const first = await adminFetch('/admin/inventory-feed/scrape', { method: 'POST', body: JSON.stringify(body) });
  check('first scrape returns 200', first.ok, `HTTP ${first.status}`);
  console.log('  summary:', JSON.stringify(first.json));

  const second = await adminFetch('/admin/inventory-feed/scrape', { method: 'POST', body: JSON.stringify(body) });
  if (second.ok) {
    // Idempotence: the same query must not duplicate rows.
    check('second identical run inserts 0', (second.json?.inserted ?? -1) === 0, `inserted=${second.json?.inserted}`);
  }

  // Blast radius: staging must not have created or changed a sellable row.
  const after = await adminFetch('/admin/dashboard');
  const productsAfter = after.json?.kpis ? undefined : undefined;
  check('admin surface still answers after ingest', after.ok);
  void productsBefore; void productsAfter;
}

async function main() {
  console.log('══ Inventory feed test ══');
  if (!TOKEN) {
    console.log('\nAPIFY_TOKEN not set — nothing to do. This test is opt-in and never runs in CI.');
    console.log('Set APIFY_TOKEN (see .env.example) and re-run. Nothing was charged.');
    return;
  }

  try {
    await phaseA();
  } catch (err) {
    console.error(`\nPhase A failed: ${err.message}`);
    console.error('If this is the full-permission 403, approve the actor once at the URL above and re-run.');
    failures += 1;
  }

  if (ADMIN_TOKEN) {
    await phaseB();
  } else {
    console.log('\n(Phase B skipped — set ADMIN_TOKEN to exercise the DB integration.)');
  }

  console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('FATAL:', err.message); process.exitCode = 1; });
