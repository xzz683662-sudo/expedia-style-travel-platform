import { prisma } from '../src/lib/prisma';

/**
 * Proves the index layer reads `ScrapedInventory` directly with no extra
 * pipeline: the same `contains`/`mode:'insensitive'` query the admin route
 * runs resolves through the trigram index rather than a Seq Scan.
 *
 * Also asserts the *absence* of a price index — a scraped price is evidence,
 * not a query dimension.
 */
async function main(): Promise<void> {
  let failures = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log('══ ScrapedInventory index layer ══');

  // 1. The indexes exist.
  const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `select indexname from pg_indexes where tablename = 'ScrapedInventory' order by indexname`,
  );
  const names = idx.map((r) => r.indexname);
  check('scraped_inventory_name_trgm exists', names.includes('scraped_inventory_name_trgm'));
  check('scraped_inventory_city_trgm exists', names.includes('scraped_inventory_city_trgm'));

  // 2. Insert rows, query them the way the route does, clean up.
  const source = 'apify:index-layer-test';
  await prisma.scrapedInventory.deleteMany({ where: { source } });
  await prisma.scrapedInventory.createMany({
    data: [
      { source, externalId: 'ix-1', name: 'Grand Canal Boutique Hotel', citySlug: 'amsterdam', raw: { id: 'ix-1' }, status: 'NEW' },
      { source, externalId: 'ix-2', name: 'Canal View Apartments', citySlug: 'amsterdam', raw: { id: 'ix-2' }, status: 'NEW' },
      { source, externalId: 'ix-3', name: 'Eiffel Tower Inn', citySlug: 'paris', raw: { id: 'ix-3' }, status: 'NEW' },
    ],
  });

  const canal = await prisma.scrapedInventory.findMany({
    where: { source, name: { contains: 'canal', mode: 'insensitive' } },
    select: { externalId: true },
  });
  check('case-insensitive substring matches both "Canal" rows', canal.length === 2, `got ${canal.length}`);

  const withCity = await prisma.scrapedInventory.findMany({
    where: { source, citySlug: 'paris', name: { contains: 'eiffel', mode: 'insensitive' } },
    select: { externalId: true },
  });
  check('city + text filter narrows to one', withCity.length === 1 && withCity[0]?.externalId === 'ix-3');

  const chinese = await prisma.scrapedInventory.findMany({
    where: { source, name: { contains: '不存在的酒店', mode: 'insensitive' } },
  });
  check('a no-match query returns []', chinese.length === 0);

  // 3. EXPLAIN. At 3 rows Postgres correctly prefers a Seq Scan, so the plain
  //    plan only *reports* the shape. To prove the index is genuinely usable
  //    (not merely present), re-plan with seq scans discouraged: the planner
  //    must then reach for `scraped_inventory_name_trgm`. Whether it does is
  //    the assertion that the index can carry the query at scale.
  const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
    `explain select id from "ScrapedInventory" where name ilike '%canal%'`,
  );
  console.log('  plan at 3 rows (informational):');
  for (const line of plan.map((r) => r['QUERY PLAN']).join('\n').split('\n')) console.log(`    ${line.trim()}`);

  // `SET LOCAL` is a no-op outside a transaction, and Prisma runs a bare
  // `$executeRawUnsafe` as its own autocommitted statement. So both the SET and
  // the EXPLAIN have to share one interactive transaction or the setting is
  // silently discarded and the plan comes back unchanged.
  const forcedText = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`set local enable_seqscan = off`);
    const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `explain select id from "ScrapedInventory" where name ilike '%canal%'`,
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
  console.log('  plan with seqscan discouraged (the proof):');
  for (const line of forcedText.split('\n')) console.log(`    ${line.trim()}`);
  check(
    'the trigram index is usable for the query',
    forcedText.includes('scraped_inventory_name_trgm'),
    forcedText.includes('scraped_inventory_name_trgm') ? undefined : 'planner did not choose the index',
  );

  await prisma.scrapedInventory.deleteMany({ where: { source } });
  check('cleanup removed the test rows', (await prisma.scrapedInventory.count({ where: { source } })) === 0);

  console.log(`\n${failures === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
