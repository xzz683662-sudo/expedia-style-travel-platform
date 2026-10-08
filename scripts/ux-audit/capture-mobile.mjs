import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Mobile viewport walk-through. Captures the phone at successive scroll
 * positions, which is the only way to judge what a phone user actually sees —
 * an element screenshot hides the surrounding layout that makes a page feel
 * broken.
 *
 *   node scripts/ux-audit/capture-mobile.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/verify/mobile';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const height = await page.evaluate(() => document.documentElement.scrollHeight);
console.log('page height:', height);

const stops = [0, 0.18, 0.36, 0.54, 0.72, 0.9];
let index = 0;
for (const ratio of stops) {
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(height * ratio));
  await page.waitForTimeout(700);
  const path = `${out}/${String(index).padStart(2, '0')}-scroll.png`;
  await page.screenshot({ path });
  console.log(`  ✓ ${path} (y=${Math.round(height * ratio)})`);
  index += 1;
}

// Overflow check at this width.
const overflow = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1) offenders.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').slice(0, 34)}`);
  }
  return { bodyScrollWidth: document.body.scrollWidth, clientWidth: vw, offenders: offenders.slice(0, 6) };
});
console.log('overflow:', JSON.stringify(overflow));

await browser.close();
console.log(`\n→ ${out}`);
