import { InventorySource, ProductStatus, ScrapedStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { promoteScrapedRow, rejectScrapedRow } from '../src/modules/inventory-feed/promote';

/**
 * Integration check for the inventory feed's promotion step — Step 6 of the
 * integration design. Needs a live database; NOT part of `pnpm verify` (verify
 * must not depend on mutable DB state beyond what smoke already does).
 *
 *   (cd apps/api && set -a && . ../../.env && set +a && ../../node_modules/.bin/tsx prisma/inventory-feed-integration.ts)
 *
 * It proves the promises the design makes, against real rows:
 *   - staging writes ONLY `ScrapedInventory` (blast radius);
 *   - a promoted product is priced from the operator's cost, never the scrape;
 *   - the scrape's figure is preserved in the audit row but never in a sellable
 *     column;
 *   - promotion is idempotent;
 *   - a rejected row cannot be promoted.
 *
 * Everything it creates is removed at the end, so it is safe to re-run.
 */

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const SOURCE = 'apify:integration-test';
const RUN = Date.now().toString(36);

async function counts() {
  const [product, ticketType, inventoryRecord] = await Promise.all([
    prisma.product.count(),
    prisma.ticketType.count(),
    prisma.inventoryRecord.count(),
  ]);
  return { product, ticketType, inventoryRecord };
}

async function main(): Promise<void> {
  console.log('══ Inventory feed integration ══');

  const destination = await prisma.destination.findFirst({ where: { level: 'CITY' }, select: { slug: true } });
  if (!destination) {
    console.log('  no CITY destination in the database — run the seed first. Skipping.');
    return;
  }

  const before = await counts();
  console.log(`  baseline: ${before.product} products, ${before.ticketType} ticket types, ${before.inventoryRecord} inventory rows`);

  // --- stage two rows (what `ingestApifyHotels` produces) -------------------
  const stagedA = await prisma.scrapedInventory.create({
    data: {
      source: SOURCE,
      externalId: `A-${RUN}`,
      name: `Integration Hotel A ${RUN}`,
      citySlug: 'amsterdam',
      countryCode: 'NL',
      starRating: 4,
      priceCents: 55555,
      currency: 'EUR',
      rawPriceText: '555.55',
      raw: { id: `A-${RUN}`, name: `Integration Hotel A ${RUN}`, price: { amount: 555.55, currency: 'EUR' } },
    },
  });
  const stagedB = await prisma.scrapedInventory.create({
    data: {
      source: SOURCE,
      externalId: `B-${RUN}`,
      name: `Integration Hotel B ${RUN}`,
      raw: { id: `B-${RUN}`, name: `Integration Hotel B ${RUN}` },
    },
  });

  const afterStaging = await counts();
  check('staging changes no Product', afterStaging.product === before.product, `${before.product} → ${afterStaging.product}`);
  check('staging changes no TicketType', afterStaging.ticketType === before.ticketType);
  check('staging changes no InventoryRecord', afterStaging.inventoryRecord === before.inventoryRecord);

  // --- promote A ------------------------------------------------------------
  const costCents = 12_345;
  const basePriceCents = 19_900;
  const promoted = await promoteScrapedRow({
    scrapedId: stagedA.id,
    actorId: 'integration-test',
    actorRole: 'ADMIN',
    costCents,
    basePriceCents,
    currency: 'USD',
    destinationSlug: destination.slug,
    nameEn: `Integration Hotel A ${RUN}`,
  });

  const product = await prisma.product.findUnique({ where: { id: promoted.productId }, include: { ticketTypes: true } });
  const ticketType = product?.ticketTypes[0];
  const afterPromote = await counts();

  check('promote creates one Product', afterPromote.product === before.product + 1);
  check('product type is HOTEL_ROOM', product?.type === 'HOTEL_ROOM');
  check('product is DRAFT (not sellable without review)', product?.status === ProductStatus.DRAFT);
  check('fulfilment defaults to CONFIRMATION', product?.fulfillment === 'CONFIRMATION');
  check('product links back to the staged row', product?.sourceScrapedId === stagedA.id);
  check('ticketType.basePriceCents is the operator price', ticketType?.basePriceCents === basePriceCents, `=${ticketType?.basePriceCents}`);
  check('ticketType.costCents is the operator cost', ticketType?.costCents === costCents, `=${ticketType?.costCents}`);
  check('ticketType.currency is honoured', ticketType?.currency === 'USD');
  check('inventorySource is MERCHANT_FEED', ticketType?.inventorySource === InventorySource.MERCHANT_FEED);
  check(
    'the scraped price never reached basePriceCents',
    ticketType?.basePriceCents !== stagedA.priceCents && ticketType?.basePriceCents === basePriceCents,
    `scraped=${stagedA.priceCents} base=${ticketType?.basePriceCents}`,
  );

  const stagedAfter = await prisma.scrapedInventory.findUnique({ where: { id: stagedA.id } });
  check('staged row is PROMOTED', stagedAfter?.status === ScrapedStatus.PROMOTED);
  check('staged row records the product', stagedAfter?.promotedProductId === promoted.productId);

  const audit = await prisma.auditLog.findFirst({ where: { entityId: promoted.productId, action: 'inventory_feed.promote' } });
  check('an audit row exists', audit !== null);
  const auditAfter = audit?.after as Record<string, unknown> | null;
  const auditBefore = audit?.before as Record<string, unknown> | null;
  check('audit records the chosen cost', auditAfter?.costCents === costCents);
  check('audit records the scraped price it did NOT use', auditBefore?.scrapedPriceCents === stagedA.priceCents);

  // --- idempotence ----------------------------------------------------------
  const again = await promoteScrapedRow({
    scrapedId: stagedA.id,
    actorId: 'integration-test',
    costCents,
    basePriceCents,
    currency: 'USD',
    destinationSlug: destination.slug,
  });
  const afterSecond = await counts();
  check('re-promoting returns the same product', again.productId === promoted.productId);
  check('re-promoting is flagged alreadyPromoted', again.alreadyPromoted === true);
  check('re-promoting creates no extra Product', afterSecond.product === afterPromote.product);

  // --- rejection ------------------------------------------------------------
  const rejected = await rejectScrapedRow({ scrapedId: stagedB.id, actorId: 'integration-test' });
  check('reject sets REJECTED', rejected.status === ScrapedStatus.REJECTED);

  let promoteRejectedThrew = false;
  try {
    await promoteScrapedRow({
      scrapedId: stagedB.id,
      actorId: 'integration-test',
      costCents: 100,
      basePriceCents: 200,
      currency: 'USD',
      destinationSlug: destination.slug,
    });
  } catch {
    promoteRejectedThrew = true;
  }
  check('a rejected row cannot be promoted', promoteRejectedThrew);

  // --- cleanup --------------------------------------------------------------
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [promoted.productId, stagedB.id] } } });
  await prisma.product.delete({ where: { id: promoted.productId } }).catch(() => undefined);
  await prisma.scrapedInventory.deleteMany({ where: { source: SOURCE } });

  const afterCleanup = await counts();
  check('cleanup restores the baseline', afterCleanup.product === before.product && afterCleanup.ticketType === before.ticketType);

  console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${checks - failures}/${checks} checks`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('INTEGRATION FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
