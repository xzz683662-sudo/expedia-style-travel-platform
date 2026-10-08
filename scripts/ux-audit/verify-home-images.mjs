/**
 * Double-ended check of the home page imagery.
 *
 * The user-visible defect this exists for: the home page showed the same
 * photograph several times, because the rails are independent queries and one
 * product came first in all four. Counting `<img>` tags in the server HTML only
 * proves the *markup*; this drives a real browser, at both breakpoints, and
 * reads what actually rendered in the DOM.
 *
 *   node scripts/ux-audit/verify-home-images.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = 'artifacts/ux-audit';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 393, height: 851 },
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
let failures = 0;

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });

  // `networkidle` never fires with the realtime WebSocket connected.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('img', { timeout: 15_000 });
  await page.waitForTimeout(1_200);

  const report = await page.evaluate(() => {
    const images = [...document.querySelectorAll('img')];
    const srcs = images.map((img) => img.getAttribute('src') ?? '');
    const counts = new Map();
    for (const src of srcs) counts.set(src, (counts.get(src) ?? 0) + 1);

    return {
      total: images.length,
      distinct: counts.size,
      duplicates: [...counts.entries()].filter(([, n]) => n > 1).map(([src, n]) => ({ src, n })),
      // A broken image is the other half of "the page looks wrong".
      broken: images.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute('src')),
      pending: images.filter((img) => !img.complete).length,
      // Three in-line columns of chips over a tile, the defect fixed earlier.
      overlays: document.querySelectorAll('.product-ribbon').length,
      horizontalOverflow: document.body.scrollWidth > window.innerWidth,
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });

  await page.screenshot({ path: `${OUT}/home-${viewport.name}.png`, fullPage: true });

  const dupOk = report.duplicates.length === 0;
  const brokenOk = report.broken.length === 0;
  const overflowOk = !report.horizontalOverflow;
  if (!dupOk || !brokenOk || !overflowOk) failures += 1;

  console.log(`\n── ${viewport.name} (${viewport.width}×${viewport.height})`);
  console.log(`  images: ${report.total} | distinct: ${report.distinct} | duplicated: ${report.duplicates.length}`);
  console.log(`  ${dupOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} no photograph repeats`);
  console.log(`  ${brokenOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} every image loaded (${report.pending} still pending)`);
  console.log(`  ${overflowOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} no horizontal overflow (${report.scrollWidth} vs ${report.innerWidth})`);
  console.log(`  ${report.overlays === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} no overlay ribbon on card media`);
  for (const dup of report.duplicates.slice(0, 6)) console.log(`      x${dup.n} ${dup.src.slice(0, 120)}`);
  for (const src of report.broken.slice(0, 6)) console.log(`      broken ${String(src).slice(0, 120)}`);

  await page.close();
}

await browser.close();

console.log(`\n${failures === 0 ? 'Home page imagery is clean at both breakpoints.' : `${failures} viewport(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
