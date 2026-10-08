import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Visual verification of the three fixes:
 *   1. broken destinaiton images  (was 13 dead URLs)
 *   2. white-on-light caption when an image is missing
 *   3. Chinese text rendering in a real webfont
 *
 *   node scripts/ux-audit/capture-fix-verification.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/fix-verification';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function capture(name, { locale, viewport, scrollTo }) {
  const page = await browser.newPage({ viewport });
  if (locale) {
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: base }]);
  }
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const brokenImages = await page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth === 0 && img.getBoundingClientRect().width > 0)
      .map((img) => img.currentSrc || img.src),
  );

  const fonts = await page.evaluate(() => ({
    latin: document.fonts.check('16px Inter'),
    cjk: getComputedStyle(document.body).fontFamily.slice(0, 110),
    loadedCount: document.fonts.size,
  }));

  if (scrollTo) {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), scrollTo);
    await page.waitForTimeout(800);
  }

  await page.screenshot({ path: `${out}/${name}.png`, fullPage: Boolean(scrollTo) === false });

  console.log(`\n${name}`);
  console.log(`  broken images: ${brokenImages.length}${brokenImages.length ? ` → ${brokenImages.slice(0, 3).join(', ')}` : ''}`);
  console.log(`  fonts loaded: ${fonts.loadedCount}; body stack: ${fonts.cjk}`);

  await page.close();
  return brokenImages.length;
}

const en = await capture('home-en', { locale: 'en-US', viewport: { width: 1440, height: 900 }, scrollTo: '.destination-tile' });
const zh = await capture('home-zh', { locale: 'zh-CN', viewport: { width: 1440, height: 900 }, scrollTo: '.destination-tile' });
const mob = await capture('home-zh-mobile', { locale: 'zh-CN', viewport: { width: 393, height: 851 }, scrollTo: '.destination-tile' });

await browser.close();
console.log(`\n${en + zh + mob === 0 ? '\x1b[32mno broken images\x1b[0m' : `\x1b[31m${en + zh + mob} broken\x1b[0m`}`);
console.log(`screenshots → ${out}`);
