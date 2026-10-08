import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Section-level screenshots, sized so the result is actually reviewable.
 * A full-page shot of this homepage is ~4000px tall and unreadable when scaled.
 *
 *   node scripts/ux-audit/capture-sections.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/verify/sections';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function capture(locale, viewport, tag) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  if (locale === 'zh') {
    await page.context().addCookies([{ name: 'easytrip_lang', value: 'zh', url: base }]);
  }
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const targets = [
    ['hero', '.hero-premium'],
    ['promo', '.promo-strip, [class*="promo"]'],
    ['destinations', 'section:has(.destination-tile)'],
    ['trending', 'section:has(.product-card)'],
  ];

  for (const [name, selector] of targets) {
    const el = page.locator(selector).first();
    if (!(await el.count())) {
      console.log(`  – ${tag}/${name}: not present`);
      continue;
    }
    await el.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(400);
    await el.screenshot({ path: `${out}/${tag}-${name}.png` }).catch((error) => {
      console.log(`  ✗ ${tag}/${name}: ${error.message.slice(0, 80)}`);
    });
    console.log(`  ✓ ${tag}/${name}`);
  }

  await page.close();
}

await capture('en', { width: 1440, height: 900 }, 'en-desktop');
await capture('zh', { width: 1440, height: 900 }, 'zh-desktop');
await capture('en', { width: 390, height: 844 }, 'en-mobile');

await browser.close();
console.log(`\nsections → ${out}`);
