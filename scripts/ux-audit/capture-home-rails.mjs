/**
 * Close-up captures of the home-page rails, so image quality can be judged
 * rather than only counted. Two viewports, 2× scale, one file per rail.
 *
 *   node scripts/ux-audit/capture-home-rails.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = 'artifacts/ux-audit/rails';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

for (const [name, width] of [['desktop', 1440], ['mobile', 393]]) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_800);

  // Each `section` holds one merchandised rail.
  const sections = await page.locator('main section, body > div > section').all();
  let index = 0;
  for (const section of sections) {
    const box = await section.boundingBox();
    if (!box || box.height < 120) continue;
    index += 1;
    await section.screenshot({ path: `${OUT}/${name}-${String(index).padStart(2, '0')}.png` }).catch(() => {});
  }
  console.log(`${name}: captured ${index} sections`);

  // The first product rail, scrolled into view at 2×, is the clearest read of
  // whether a card's photograph matches what the card sells.
  const cards = page.locator('section .product-card, section .card').first();
  await cards.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}-viewport.png` });

  await page.close();
}

await browser.close();
console.log(`wrote ${OUT}`);
