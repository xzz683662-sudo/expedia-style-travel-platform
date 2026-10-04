/**
 * ---------------------------------------------------------------------------
 * Supply import CLI
 * ---------------------------------------------------------------------------
 *
 *   pnpm --filter @easytrip/api supply:import              # full OurAirports
 *   pnpm --filter @easytrip/api supply:import -- --limit=500
 *
 * Runs the identity/geometry import described in docs/supply-sources.md. It
 * deliberately does not touch prices or stock: those belong to
 * `modules/pricing` and `modules/inventory`, and an import that set them would
 * silently override whatever the pricing engine decided.
 *
 * Safe to re-run. Airports upsert on their IATA code and provenance upserts on
 * `(sourceId, externalId)`, so a monthly refresh updates rows in place.
 */

import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import { OurAirportsSource } from '../src/modules/supply/ourairports';
import { importAirportsFrom } from '../src/modules/supply/import';

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const limitRaw = readFlag('limit');
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new Error(`--limit must be a number, got ${limitRaw}`);
  }

  const source = new OurAirportsSource();
  logger.info('supply.import_started', { source: source.id, license: source.license, limit: limit ?? 'all' });

  const result = await importAirportsFrom(source, { limit });

  // Printed as well as logged: this is a CLI, and the operator running it is
  // watching stdout, not a log aggregator.
  process.stdout.write(
    `\nImported ${result.source} (${source.license})\n` +
      `  scanned:  ${result.scanned}\n` +
      `  created:  ${result.created}\n` +
      `  updated:  ${result.updated}\n` +
      `  rejected: ${result.rejected}\n` +
      `  took:     ${(result.durationMs / 1000).toFixed(1)}s\n\n`,
  );
}

main()
  .catch((error) => {
    logger.error('supply.import_failed', {
      reason: (error as Error).message,
      stack: (error as Error).stack,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });