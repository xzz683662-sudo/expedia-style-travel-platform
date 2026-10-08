/**
 * Re-run only the category-extension backfill.
 *
 * The full `seed.ts` spends ~6 minutes regenerating 214k inventory rows, none of
 * which this touches. The backfill is idempotent-by-comparison, so running it
 * alone is enough to repair a `ProductFlight` / `FlightSegment` schedule after
 * the generator changes.
 *
 *   (cd apps/api && set -a && . ../../.env && set +a && npx tsx prisma/backfill-extensions.ts)
 */
import { prisma } from '../src/lib/prisma';
import { backfillCategoryExtensions } from './seed-category-extensions';

backfillCategoryExtensions(prisma)
  .then((counts) => {
    console.log('extension backfill:', JSON.stringify(counts));
    return prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
