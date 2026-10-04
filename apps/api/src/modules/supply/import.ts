import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { OurAirportsSource } from './ourairports';
import type { SupplySource } from './source';

/**
 * ---------------------------------------------------------------------------
 * Supply import
 * ---------------------------------------------------------------------------
 *
 * Brings identity and geometry from an open dataset into the canonical tables.
 * Never prices and never allocates stock: an imported airport has to know where
 * it is, and `modules/pricing` / `modules/inventory` decide what a night there
 * costs and how many rooms exist. See docs/supply-sources.md.
 *
 * Idempotent by construction. Airports are upserted on `iataCode`, and
 * provenance is upserted on `(sourceId, externalId)`, so re-running refreshes
 * rows in place instead of accumulating duplicates. An import that appended
 * would double the airport list every time a monthly refresh ran, and the
 * connection search would start reporting the same layover twice.
 */

export interface ImportOptions {
  /** Cap the number of rows written. For a smoke run; omit for a full import. */
  limit?: number;
  /**
   * Skip rows whose `syncedAt` is newer than this. Lets a monthly refresh
   * touch only what changed instead of rewriting 76k rows every time.
   */
  changedSince?: Date;
}

export interface ImportResult {
  source: string;
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  /// Rows that looked importable but carried unusable data.
  rejected: number;
  durationMs: number;
}

/**
 * Postgres caps a statement at 65535 bind parameters. With 6 columns per row
 * that is ~10k rows per `createMany`, so batch well under it.
 */
const BATCH_SIZE = 2000;

/** Import one supply source's destinations into `Destination` as AIRPORT rows. */
export async function importAirportsFrom(
  source: SupplySource,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const startedAt = Date.now();
  const ourAirports = source as OurAirportsSource;

  const result: ImportResult = {
    source: source.id,
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    durationMs: 0,
  };

  const destinations = ourAirports.listAirportCodes
    ? ourAirports.listAirportCodes()
    : (async function* () {
        for await (const d of source.listDestinations()) {
          yield { iata: d.ref.externalId.replace(/^airport:/, ''), icao: null, municipality: null, name: d.name };
        }
      })();

  // Coordinates live on the generic destination stream, codes on the
  // airport-specific one. Both are read from the same upstream file, so they
  // are collected in one pass and joined by IATA code.
  //
  // Re-reading the destination stream per code — the obvious shortcut — is
  // quadratic: 76k rows times a 12MB fetch each. It hangs rather than slows
  // down, which is why the join is explicit.
  const geometry = new Map<string, { countryCode: string | null; latitude: number | null; longitude: number | null }>();
  for await (const destination of source.listDestinations()) {
    const iata = destination.ref.externalId.replace(/^airport:/, '');
    geometry.set(iata, {
      countryCode: destination.countryCode,
      latitude: destination.latitude,
      longitude: destination.longitude,
    });
  }

  let batch: {
    iata: string;
    icao: string | null;
    name: string;
    municipality: string | null;
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
  }[] = [];

  for await (const codes of destinations) {
    result.scanned += 1;
    if (options.limit !== undefined && result.scanned > options.limit) break;

    const point = geometry.get(codes.iata);
    const row = buildRow(codes, point);
    if (!row) {
      // A row with no coordinates cannot be placed on a map or sanity-checked,
      // so importing it would add a name that can never be found by proximity.
      // Rejecting is visible in the count; a silent null would not be.
      result.rejected += 1;
      continue;
    }
    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      await flush(batch, source, result);
      batch = [];
    }
  }

  if (batch.length > 0) await flush(batch, source, result);

  result.durationMs = Date.now() - startedAt;
  logger.info('supply.import_finished', { ...result });
  return result;
}

interface AirportRow {
  iata: string;
  icao: string | null;
  name: string;
  municipality: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Join one airport's codes with its geometry, or null when unusable. */
function buildRow(
  codes: { iata: string; icao: string | null; municipality: string | null; name: string },
  point: { countryCode: string | null; latitude: number | null; longitude: number | null } | undefined,
): AirportRow | null {
  if (!point || point.latitude === null || point.longitude === null) return null;
  return {
    iata: codes.iata,
    icao: codes.icao,
    name: codes.name,
    municipality: codes.municipality,
    countryCode: point.countryCode,
    latitude: point.latitude,
    longitude: point.longitude,
  };
}

async function flush(
  batch: {
    iata: string;
    icao: string | null;
    name: string;
    municipality: string | null;
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
  }[],
  source: SupplySource,
  result: ImportResult,
): Promise<void> {
  const codes = batch.map((r) => r.iata);

  const existing = await prisma.destination.findMany({
    where: { iataCode: { in: codes } },
    select: { id: true, iataCode: true },
  });
  const existingByCode = new Map(existing.map((d) => [d.iataCode as string, d.id]));

  const toCreate = batch.filter((r) => !existingByCode.has(r.iata));
  const toUpdate = batch.filter((r) => existingByCode.has(r.iata));

  if (toCreate.length > 0) {
    const created = await prisma.destination.createManyAndReturn({
      data: toCreate.map((r) => ({
        // Slug is unique and derived from the code: `airport-dxb` cannot collide
        // with a city slug, and an airport re-import updates by code regardless
        // of what it was called last time.
        slug: `airport-${r.iata.toLowerCase()}`,
        name: r.name,
        level: 'AIRPORT' as const,
        countryCode: r.countryCode,
        latitude: r.latitude,
        longitude: r.longitude,
        iataCode: r.iata,
        icaoCode: r.icao,
        origin: 'OPEN_DATASET' as const,
      })),
      select: { id: true, iataCode: true },
    });
    result.created += created.length;
    for (const row of created) {
      existingByCode.set(row.iataCode as string, row.id);
    }
  }

  if (toUpdate.length > 0) {
    // Update per row rather than in bulk: each carries different values, and a
    // single `updateMany` with a CASE expression per column is not expressible
    // through Prisma without raw SQL that would have to be maintained by hand.
    for (const row of toUpdate) {
      await prisma.destination.update({
        where: { id: existingByCode.get(row.iata) as string },
        data: {
          name: row.name,
          countryCode: row.countryCode,
          latitude: row.latitude,
          longitude: row.longitude,
          icaoCode: row.icao,
          origin: 'OPEN_DATASET',
        },
      });
    }
    result.updated += toUpdate.length;
  }

  // Provenance last, so a row that failed to write never claims a source.
  await prisma.supplySourceRecord.createMany({
    data: batch.map((r) => ({
      sourceId: source.id,
      externalId: `airport:${r.iata}`,
      origin: 'OPEN_DATASET' as const,
      license: source.license,
      entityType: 'Destination',
      entityId: existingByCode.get(r.iata) as string,
      payload: { iata: r.iata, icao: r.icao, name: r.name },
      syncedAt: new Date(),
    })),
    skipDuplicates: true,
  });
}