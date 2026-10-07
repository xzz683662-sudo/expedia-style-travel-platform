import { Prisma, ScrapedStatus } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { toServiceDate } from '../../utils/date';
import { AppError } from '../../utils/errors';

/**
 * ---------------------------------------------------------------------------
 * Inventory feed — ingest (stage only)
 * ---------------------------------------------------------------------------
 *
 * Pulls hotel rows from the Apify Expedia Hotels actor and stages them in
 * `ScrapedInventory`. It is the ONLY writer of that table, and it writes nothing
 * else.
 *
 * The rule this file exists to enforce, in the repo's own words
 * (`docs/supply-sources.md`): *"Prices and availability are never imported —
 * only identity and geometry."* A scraped price is another company's displayed
 * retail rate: stale by minutes, already marked up, and sold under terms that do
 * not permit resale. Writing one into `TicketType.basePriceCents` would let a
 * scraper bug become a pricing bug at scale and corrupt the `OrderItem`
 * snapshots that explain previous orders.
 *
 * Therefore:
 *   - **This module must not import `pricing/`, `inventory/` or `booking/`.**
 *     `pnpm inventory:contract` asserts that statically, offline.
 *   - **Nothing that reads `Product` may read `ScrapedInventory`.** A row becomes
 *     sellable only through the audited promotion step in `promote.ts`.
 *
 * Two realities shape the error handling:
 *   - The actor's published 30-day success rate measured **0.107%**
 *     (29 succeeded of 27,214 runs, 2026-10-06). An empty dataset is a normal
 *     outcome, never an exception.
 *   - A run is billed per platform usage. So the planned row count is logged
 *     *before* the run starts, and `maxRowsPerRun` is a hard cap.
 *
 * The exact row shape could not be calibrated against a live run (the actor has
 * `FULL_PERMISSIONS` and needs console approval first), so the field mapping
 * below is deliberately tolerant: it resolves each value from several candidate
 * paths and stores the **untouched payload** in `ScrapedInventory.raw`. A feed
 * schema change is then a mapping edit plus a backfill from `raw` — never a paid
 * re-scrape. A fixture-driven `pnpm inventory:contract` covers the mapping.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Apify REST base. `fetch` only — the repo's dependency list stays lean. */
const APIFY_BASE = 'https://api.apify.com/v2';

interface ApifyRunRef {
  runId: string | null;
  datasetId: string | null;
  status: string;
}

async function apifyFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = config.inventoryFeed.apifyToken;
  if (!token) throw AppError.badRequest('APIFY_TOKEN is not configured');

  const url = `${APIFY_BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    // A 403 here is the `full-permission-actor-not-approved` case: the actor
    // wants account-wide permission and an operator has to grant it in the
    // console. Surface the approval URL so the admin UI can link to it rather
    // than making someone read a log line.
    const message = json?.error?.message ?? `Apify request failed with HTTP ${res.status}`;
    const approvalUrl = json?.error?.data?.approvalUrl;
    logger.warn('inventory_feed.apify_error', { path, status: res.status, message });
    throw new AppError(502, 'INTERNAL', message, { status: res.status, approvalUrl });
  }
  return json;
}

export interface ApifyRunInput {
  location: string[];
  checkIn?: string;
  checkOut?: string;
  limit: number;
  /** Portal id selecting region/currency. Defaults to `config.inventoryFeed.site`. */
  site?: string;
  language?: string;
  /** `includes:*` block names to request. Defaults to the configured list. */
  includes?: string[];
}

/**
 * Builds the actor's input object from the documented schema.
 *
 * Every field here is one the actor's published input schema actually declares
 * (`location` array, `limit`, `check_in`, `check_out`, `site`, `language`,
 * `includes:*`). `site` is validated upstream as a **numeric portal id**, so it
 * is passed through verbatim rather than derived from a hostname.
 *
 * `includes:*` keys are literally named `includes:offers` etc. — the colon is
 * part of the key, which is why it is built rather than written as a fixed
 * object literal.
 */
function buildActorInput(input: ApifyRunInput): Record<string, unknown> {
  const includes = input.includes ?? config.inventoryFeed.includes;
  const body: Record<string, unknown> = {
    location: input.location,
    limit: input.limit,
    site: input.site ?? config.inventoryFeed.site,
    language: input.language ?? config.inventoryFeed.language,
    ...(input.checkIn ? { check_in: input.checkIn } : {}),
    ...(input.checkOut ? { check_out: input.checkOut } : {}),
  };
  for (const name of includes) body[`includes:${name}`] = name === 'availability' ? 3 : true;

  // Operator-supplied egress. Parsed defensively: a malformed value must not
  // take down an ingest, it should fall back to the actor's default proxy and
  // let the operator see the warning.
  if (config.inventoryFeed.proxyConfig) {
    try {
      body.dev_proxy_config = JSON.parse(config.inventoryFeed.proxyConfig);
    } catch {
      logger.warn('inventory_feed.proxy_config_invalid', { reason: 'APIFY_HOTEL_PROXY_CONFIG is not valid JSON; using the actor default' });
    }
  }
  return body;
}

/**
 * Starts one actor run and polls it to a terminal state.
 *
 * Returns the run and its dataset rather than rows, so a caller can decide
 * whether fetching items is worth it. Never throws on an *empty* dataset — only
 * a transport or permission failure is an error.
 */
export async function runApifyActor(input: ApifyRunInput): Promise<ApifyRunRef> {
  const slug = config.inventoryFeed.apifyActor.replace('/', '~');
  const body = buildActorInput(input);

  // State the planned size *before* spending anything: a run is a bill.
  logger.info('inventory_feed.run_starting', { actor: config.inventoryFeed.apifyActor, limit: input.limit, location: input.location, site: body.site });

  const started = (await apifyFetch(`/acts/${slug}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as any;
  const run = started?.data ?? started;
  const runId: string | null = run?.id ?? null;
  const datasetId: string | null = run?.defaultDatasetId ?? null;
  let status: string = run?.status ?? 'READY';

  const deadline = Date.now() + config.inventoryFeed.runTimeoutMs;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() > deadline || !runId) break;
    await new Promise((resolve) => setTimeout(resolve, config.inventoryFeed.pollIntervalMs));
    const polled = (await apifyFetch(`/actor-runs/${runId}`)) as any;
    const data = polled?.data ?? polled;
    status = data?.status ?? status;
  }

  logger.info('inventory_feed.run_finished', { runId, datasetId, status });
  return { runId, datasetId, status };
}

/** Fetches dataset items, paged, capped at `limit`. */
export async function fetchDatasetItems(datasetId: string, limit: number): Promise<unknown[]> {
  const pageSize = Math.min(1000, Math.max(1, limit));
  const rows: unknown[] = [];
  let offset = 0;

  while (rows.length < limit) {
    const want = Math.min(pageSize, limit - rows.length);
    const page = (await apifyFetch(
      `/datasets/${datasetId}/items?clean=true&format=json&limit=${want}&offset=${offset}`,
    )) as unknown;
    const items = Array.isArray(page) ? page : [];
    if (items.length === 0) break;
    rows.push(...items);
    offset += items.length;
    if (items.length < want) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PII stripping (a GDPR guard, checked offline by `pnpm inventory:contract`)
// ---------------------------------------------------------------------------

/**
 * Keys that identify a person and must never reach `raw`.
 *
 * Hotel `name` and `propertyUrl` are deliberately NOT here — they are property
 * data, not personal data, and are needed downstream.
 */
const PII_KEYS = /^(reviewer|reviewer[_]?name|author|author[_]?name|email|eMail|phone|telephone|contactEmail|userName|user|userId|firstName|lastName)$/i;

/** Review fields kept when a `reviews` array is present. */
const REVIEW_KEEP = ['rating', 'score', 'stars', 'text', 'content', 'title', 'date', 'createdAt', 'publishedAt', 'reviewDate'];

/**
 * Recursively removes personal data from a scraped payload.
 *
 * Reviews are reduced to rating + text + date: the reviewer's name and location
 * are dropped, which is what makes it safe to keep guest reviews at all. Called
 * on the way *in*, so the redacted shape is the only shape that ever lands in
 * `raw` — there is no window in which the raw PII exists in the database.
 */
export function stripPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPii);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.test(key)) continue;
      if (/^reviews?$/i.test(key) && Array.isArray(nested)) {
        out[key] = nested.map((entry) => {
          if (!entry || typeof entry !== 'object') return { value: stripPii(entry) };
          const review = entry as Record<string, unknown>;
          const kept: Record<string, unknown> = {};
          for (const field of REVIEW_KEEP) if (field in review) kept[field] = stripPii(review[field]);
          return kept;
        });
        continue;
      }
      out[key] = stripPii(nested);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tolerant field resolution
//
// The candidate paths exist because the actor's published output schema is
// undocumented ("overview, extras, results, mapViewer — no description") and a
// live calibration run is blocked on permission approval. They are ordered most
// specific first. Once a real row is captured, this list should be trimmed to
// the paths that actually occur.
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

/** First defined, non-empty value among `paths`. */
function firstOf(obj: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = getPath(obj, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Try the plain form first; fall back to a European `1.234,56` reading. The
  // original string is preserved in `rawPriceText` precisely because this is a
  // judgement call and a human may need to overrule it.
  let parsed = Number.parseFloat(trimmed.replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(parsed)) parsed = Number.parseFloat(trimmed.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** `@db.Char(n)` column: upper-cased and exact, or null. */
function fixedChar(value: unknown, length: number): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return upper.length === length ? upper : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface PriceParts {
  cents: number | null;
  currency: string | null;
  text: string | null;
}

/** Finds a price and its currency wherever the payload happens to put them. */
function extractPrice(raw: unknown): PriceParts {
  const candidates = [
    'price',
    'priceCents',
    'amount',
    'totalPrice',
    'displayPrice',
    'nightlyPrice',
    'price.amount',
    'price.value',
    'offers.0.price',
    'offers.0.amount',
    'rooms.0.price',
    'rooms.0.price.amount',
    'rooms.0.amount',
  ];
  const currencyPaths = ['currency', 'currencyCode', 'price.currency', 'offers.0.currency', 'rooms.0.currency', 'rooms.0.price.currency'];

  for (const path of candidates) {
    const value = getPath(raw, path);
    if (value === undefined || value === null) continue;

    if (typeof value === 'object') {
      const amount = firstOf(value, ['amount', 'value', 'price']);
      const numeric = toNumber(amount);
      if (numeric !== null && numeric >= 0) {
        const currency = fixedChar(firstOf(value, ['currency', 'currencyCode']) ?? firstOf(raw, currencyPaths), 3);
        return { cents: Math.round(numeric * 100), currency, text: String(amount) };
      }
      continue;
    }

    const numeric = toNumber(value);
    if (numeric !== null && numeric >= 0) {
      return { cents: Math.round(numeric * 100), currency: fixedChar(firstOf(raw, currencyPaths), 3), text: String(value) };
    }
  }
  return { cents: null, currency: null, text: null };
}

/** A staged row, ready for `ScrapedInventory`. */
export interface StagedRow {
  externalId: string;
  externalRef: string | null;
  name: string;
  citySlug: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  starRating: number | null;
  propertyUrl: string | null;
  priceCents: number | null;
  currency: string | null;
  rawPriceText: string | null;
  checkIn: Date | null;
  checkOut: Date | null;
  raw: Prisma.InputJsonValue;
}

export interface NormaliseContext {
  source: string;
  runId: string | null;
  cityHint?: string;
  checkIn?: string;
  checkOut?: string;
}

/**
 * Maps one raw payload to a staged row, or `null` when it is unusable.
 *
 * Unusable means: no `externalId` (a row we could never refresh) or no `name`
 * (the one required column). Both are counted as `skipped`, never guessed —
 * inventing an id would make the next sync duplicate the row instead of
 * updating it.
 */
export function normaliseApifyRow(raw: unknown, ctx: NormaliseContext): StagedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const externalId = nonEmptyString(
    firstOf(row, ['id', 'hotelId', 'hotel_id', 'propertyId', 'property_id', 'expediaId', 'expedia_id', 'externalId']),
  );
  if (!externalId) return null;

  const name = nonEmptyString(firstOf(row, ['name', 'hotelName', 'hotel_name', 'propertyName', 'property_name', 'title']));
  if (!name) return null;

  const price = extractPrice(row);

  const latValue = toNumber(firstOf(row, ['latitude', 'lat', 'geo.latitude', 'coordinates.latitude', 'location.lat', 'location.latitude']));
  const lngValue = toNumber(firstOf(row, ['longitude', 'lng', 'lon', 'geo.longitude', 'coordinates.longitude', 'location.lng', 'location.longitude']));

  const starValue = toNumber(firstOf(row, ['starRating', 'star_rating', 'stars', 'hotelClass', 'hotel_class', 'rating']));

  const checkInRaw = ctx.checkIn ?? nonEmptyString(firstOf(row, ['checkIn', 'check_in']));
  const checkOutRaw = ctx.checkOut ?? nonEmptyString(firstOf(row, ['checkOut', 'check_out']));

  return {
    externalId,
    externalRef: nonEmptyString(firstOf(row, ['hotelsComId', 'hotels_com_id', 'externalRef', 'ref'])),
    name,
    citySlug: nonEmptyString(firstOf(row, ['citySlug', 'city_slug', 'city', 'location.name'])) ?? ctx.cityHint?.toLowerCase().replace(/\s+/g, '-') ?? null,
    countryCode: fixedChar(firstOf(row, ['countryCode', 'country_code', 'address.countryCode', 'country']), 2),
    latitude: latValue,
    longitude: lngValue,
    starRating: starValue,
    propertyUrl: nonEmptyString(firstOf(row, ['propertyUrl', 'property_url', 'url', 'link', 'hotelUrl', 'deepLink'])),
    priceCents: price.cents,
    currency: price.currency,
    rawPriceText: price.text,
    checkIn: checkInRaw ? safeDate(checkInRaw) : null,
    checkOut: checkOutRaw ? safeDate(checkOutRaw) : null,
    raw: stripPii(row) as Prisma.InputJsonValue,
  };
}

function safeDate(value: string): Date | null {
  try {
    return toServiceDate(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Stages one already-normalised row. Returns which bucket it landed in.
 *
 * Extracted so the live Apify path and the offline fixture path stage through
 * the *same* code. The idempotence rules live here and nowhere else, which is
 * what makes them hold for both: a re-run updates in place, and a `REJECTED`
 * row is never resurrected by a later sync.
 */
async function stageNormalisedRow(staged: StagedRow, meta: { source: string; runId: string | null }): Promise<'inserted' | 'updated'> {
  const existing = await prisma.scrapedInventory.findUnique({
    where: { source_externalId: { source: meta.source, externalId: staged.externalId } },
    select: { id: true, status: true },
  });

  if (existing) {
    // A `REJECTED` row is deliberately not resurrected: refreshing it would
    // silently undo an operator's decision. We only bump `syncedAt`.
    await prisma.scrapedInventory.update({
      where: { id: existing.id },
      data:
        existing.status === ScrapedStatus.REJECTED
          ? { syncedAt: new Date() }
          : {
              sourceRunId: meta.runId,
              name: staged.name,
              citySlug: staged.citySlug,
              countryCode: staged.countryCode,
              latitude: staged.latitude,
              longitude: staged.longitude,
              starRating: staged.starRating,
              propertyUrl: staged.propertyUrl,
              priceCents: staged.priceCents,
              currency: staged.currency,
              rawPriceText: staged.rawPriceText,
              checkIn: staged.checkIn,
              checkOut: staged.checkOut,
              raw: staged.raw,
              externalRef: staged.externalRef,
              syncedAt: new Date(),
              // A STALE row that reappears upstream is reviewable again.
              ...(existing.status === ScrapedStatus.STALE ? { status: ScrapedStatus.NEW } : {}),
            },
    });
    return 'updated';
  }

  await prisma.scrapedInventory.create({
    data: {
      source: meta.source,
      externalId: staged.externalId,
      sourceRunId: meta.runId,
      externalRef: staged.externalRef,
      name: staged.name,
      citySlug: staged.citySlug,
      countryCode: staged.countryCode,
      latitude: staged.latitude,
      longitude: staged.longitude,
      starRating: staged.starRating,
      propertyUrl: staged.propertyUrl,
      priceCents: staged.priceCents,
      currency: staged.currency,
      rawPriceText: staged.rawPriceText,
      checkIn: staged.checkIn,
      checkOut: staged.checkOut,
      raw: staged.raw,
    },
  });
  return 'inserted';
}

/** Normalises a batch of raw payloads and stages each one through {@link stageNormalisedRow}. */
async function stageRawPayloads(
  rows: unknown[],
  ctx: NormaliseContext,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of rows) {
    const staged = normaliseApifyRow(raw, ctx);
    if (!staged) {
      skipped += 1;
      continue;
    }
    const bucket = await stageNormalisedRow(staged, { source: ctx.source, runId: ctx.runId });
    if (bucket === 'inserted') inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, skipped };
}

export interface IngestInput {
  location: string[];
  checkIn?: string;
  checkOut?: string;
  limit?: number;
}

export interface IngestSummary {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  runId: string | null;
  status: string;
}

/**
 * Pulls one query and stages the rows. Writes ONLY `ScrapedInventory`.
 *
 * Idempotent on `(source, externalId)`: a re-run updates in place and refreshes
 * `syncedAt` rather than duplicating, which is what makes a nightly schedule
 * safe. Never throws on an empty dataset.
 */
export async function ingestApifyHotels(input: IngestInput): Promise<IngestSummary> {
  if (!config.inventoryFeed.enabled) throw AppError.forbidden('Inventory feed is disabled');
  if (!input.location?.length) throw AppError.badRequest('At least one location is required');

  const requested = input.limit ?? config.inventoryFeed.maxRowsPerRun;
  const limit = Math.min(requested, config.inventoryFeed.maxRowsPerRun);
  if (requested > config.inventoryFeed.maxRowsPerRun) {
    logger.warn('inventory_feed.limit_capped', { requested, cappedAt: config.inventoryFeed.maxRowsPerRun });
  }

  const { runId, datasetId, status } = await runApifyActor({
    location: input.location,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    limit,
  });

  if (!datasetId) {
    return { fetched: 0, inserted: 0, updated: 0, skipped: 0, runId, status };
  }

  const rows = await fetchDatasetItems(datasetId, limit);
  const source = `apify:${config.inventoryFeed.apifyActor}`;

  const { inserted, updated, skipped } = await stageRawPayloads(rows, {
    source,
    runId,
    cityHint: input.location[0],
    checkIn: input.checkIn,
    checkOut: input.checkOut,
  });

  const summary: IngestSummary = { fetched: rows.length, inserted, updated, skipped, runId, status };
  // Spread into a fresh object literal: `IngestSummary` is an interface, which has no
  // implicit index signature, so it is not assignable to the logger's `Record<string, unknown>`.
  logger.info('inventory_feed.ingest_done', { ...summary });
  return summary;
}

// ---------------------------------------------------------------------------
// Offline fixture ingest — "some data in the database" without a live upstream
// ---------------------------------------------------------------------------

/**
 * Default provenance for fixture-staged rows.
 *
 * Deliberately *not* `apify:<actor>`: these rows were not fetched, and a row
 * whose `source` claims otherwise is a lie the review queue would repeat. A
 * distinct prefix also makes them trivially filterable and cleanable
 * (`deleteMany({ where: { source: FIXTURE_SOURCE } })`).
 */
export const FIXTURE_SOURCE = 'fixture:expedia-hotels';

export interface FixtureIngestInput {
  /** Raw payloads in the actor's output shape — captured earlier, or hand-written. */
  rows: unknown[];
  cityHint?: string;
  checkIn?: string;
  checkOut?: string;
  /** Overrides {@link FIXTURE_SOURCE} so a caller can namespace per dataset. */
  source?: string;
}

export interface FixtureIngestSummary {
  source: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Stages payloads from a stored sample rather than from Apify.
 *
 * Why this exists
 * ---------------
 * The live actor's measured reliability makes it unusable as the *only* way to
 * put a row in the database: 30-day stats are **29 succeeded of 27,214 runs
 * (0.107%)**, and a re-probe on 2026-07-10 got `error: Too Many Requests` on a
 * city search. Its default egress is Apify's *shared* residential pool, which
 * Expedia throttles across every user of the actor, so the fix is an
 * operator-supplied proxy (`APIFY_HOTEL_PROXY_CONFIG` → `dev_proxy_config`) —
 * not more retries.
 *
 * Until that egress exists, the review → promote → search chain would be
 * unexercisable end to end, and an unexercised chain is one nobody has proven.
 * This function closes that gap honestly: it stages **sample** rows, labelled
 * as sample, through the *same* normaliser and the *same* staging helper the
 * live path uses — so the mapping, the PII stripping, the idempotence and the
 * promote step are all genuinely exercised, and swapping in the live actor is a
 * config change rather than a rewrite.
 *
 * What it does NOT do
 * -------------------
 * Same blast radius as every other function here: it writes **only**
 * `ScrapedInventory`. Nothing becomes sellable — a human still has to promote
 * the row, and even then it lands as `DRAFT`.
 */
export async function ingestFixtureRows(input: FixtureIngestInput): Promise<FixtureIngestSummary> {
  const source = input.source ?? FIXTURE_SOURCE;
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { source, fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  }

  const { inserted, updated, skipped } = await stageRawPayloads(input.rows, {
    source,
    runId: null,
    cityHint: input.cityHint,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
  });

  const summary: FixtureIngestSummary = { source, fetched: input.rows.length, inserted, updated, skipped };
  logger.info('inventory_feed.fixture_ingest_done', { ...summary });
  return summary;
}

/**
 * Marks staged rows that no recent successful sync has confirmed.
 *
 * Deliberately excludes `PROMOTED` rows. Under positioning option A a promoted
 * product is first-party: it has its own copy and its own cost basis, so the
 * feed going quiet does not make it stale and must not pause something the
 * platform owns. (That clause *would* apply under a live-feed positioning,
 * option B — see `docs/adr/0001-inventory-feed-positioning.md`.)
 */
export async function refreshStale(olderThanHours = config.inventoryFeed.staleAfterHours): Promise<{ stale: number }> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const { count } = await prisma.scrapedInventory.updateMany({
    where: {
      status: { in: [ScrapedStatus.NEW, ScrapedStatus.REVIEWED] },
      OR: [{ syncedAt: null, fetchedAt: { lt: cutoff } }, { syncedAt: { lt: cutoff } }],
    },
    data: { status: ScrapedStatus.STALE },
  });
  logger.info('inventory_feed.refresh_stale', { olderThanHours, stale: count });
  return { stale: count };
}

// ---------------------------------------------------------------------------
// Bulk ingest — "scrape everything obtainable into one database"
// ---------------------------------------------------------------------------

export interface BulkIngestInput {
  cities: string[];
  checkIn?: string;
  checkOut?: string;
  /** `limit` per city. */
  limitPerCity?: number;
  /** Attempts per city before giving up. */
  maxAttempts?: number;
}

export interface BulkIngestSummary {
  cities: number;
  succeeded: number;
  failed: number;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  perCity: {
    city: string;
    ok: boolean;
    fetched: number;
    inserted: number;
    updated: number;
    attempts: number;
    lastStatus?: string;
  }[];
}

/**
 * Scrapes many cities into the staging table in one call.
 *
 * The actor's measured reliability makes a batch runner necessary rather than
 * convenient: its own 30-day stats are **29 succeeded of 27,214 runs
 * (0.107%)**, and a live hunt on 2026-10-06 got **12/12 `HTTP 429`** — Expedia
 * rate-limiting the actor's residential proxy. A single query is therefore
 * *expected* to fail, and the useful unit of work is a batch that keeps going.
 *
 * Each city is retried up to `maxAttempts` times with linear backoff. A city
 * that never succeeds is reported in `perCity`, not thrown: a partial fill is
 * the normal outcome, and the operator sees exactly which cities are missing.
 * A `429` is transient upstream rate limiting, which is the only reason a retry
 * is worth doing at all.
 *
 * Everything it writes goes to `ScrapedInventory` — the same blast-radius rule
 * as the single-query path holds, because it calls the same function.
 */
export async function ingestCityBatch(input: BulkIngestInput): Promise<BulkIngestSummary> {
  if (!config.inventoryFeed.enabled) throw AppError.forbidden('Inventory feed is disabled');

  const cities = [...new Set(input.cities.map((city) => city.trim()).filter(Boolean))];
  if (cities.length === 0) throw AppError.badRequest('At least one city is required');

  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const limitPerCity = input.limitPerCity ?? config.inventoryFeed.maxRowsPerRun;

  const perCity: BulkIngestSummary['perCity'] = [];
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let succeeded = 0;

  for (const city of cities) {
    let cityFetched = 0;
    let cityInserted = 0;
    let cityUpdated = 0;
    let ok = false;
    let attempts = 0;
    let lastStatus: string | undefined;

    while (attempts < maxAttempts && !ok) {
      attempts += 1;
      try {
        const summary = await ingestApifyHotels({
          location: [city],
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          limit: limitPerCity,
        });
        lastStatus = summary.status;
        cityFetched += summary.fetched;
        cityInserted += summary.inserted;
        cityUpdated += summary.updated;
        fetched += summary.fetched;
        inserted += summary.inserted;
        updated += summary.updated;
        skipped += summary.skipped;
        // A SUCCEEDED run counts even with zero rows: "the upstream answered and
        // had nothing for us" is a real answer, and retrying it wastes money.
        ok = summary.status === 'SUCCEEDED';
      } catch (error) {
        lastStatus = (error as Error).message.slice(0, 120);
        logger.warn('inventory_feed.bulk_attempt_failed', { city, attempt: attempts, reason: lastStatus });
      }
      if (!ok && attempts < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 5_000 * attempts));
    }

    if (ok) succeeded += 1;
    perCity.push({ city, ok, fetched: cityFetched, inserted: cityInserted, updated: cityUpdated, attempts, lastStatus });
  }

  const summary: BulkIngestSummary = {
    cities: cities.length,
    succeeded,
    failed: cities.length - succeeded,
    fetched,
    inserted,
    updated,
    skipped,
    perCity,
  };
  logger.info('inventory_feed.bulk_done', {
    cities: summary.cities,
    succeeded: summary.succeeded,
    failed: summary.failed,
    fetched: summary.fetched,
    inserted: summary.inserted,
    updated: summary.updated,
  });
  return summary;
}
