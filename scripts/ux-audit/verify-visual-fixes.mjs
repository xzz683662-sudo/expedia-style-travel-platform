import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Visual verification of the image + font fixes.
 *
 * Answers, with measurements rather than opinion:
 *   1. Are there any broken images on the storefront?
 *   2. Do the destination tiles that were blank (Florence, Madrid) now paint?
 *   3. Is Chinese text rendered by the self-hosted CJK webfont?
 *   4. Does it hold at a phone width?
 *
 *   node scripts/ux-audit/verify-visual-fixes.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/verify';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

/** Counts visible images that failed to load, and checks a named font renders CJK. */
async function inspect(page) {
  return page.evaluate(() => {
    const broken = [];
    for (const img of Array.from(document.images)) {
      const rect = img.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) continue;
      if (img.complete && img.naturalWidth === 0) broken.push(`${src.slice(0, 90)}`);
    }
    return {
      brokenCount: broken.length,
      brokenSample: broken.slice(0, 6),
      totalImages: document.images.length,
      // `check(font, text)` answers "can this font render this text?".
      cjkFontAvailable: document.fonts.check('16px "Noto Sans SC"', '易捷旅行'),
      cjkInSansStack: getComputedStyle(document.body).fontFamily.includes('font-cjk'),
    };
  });
}

// --- English desktop ---------------------------------------------------------
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await desktop.goto(base, { waitUntil: 'domcontentloaded' });
await desktop.waitForTimeout(2500);
const en = await inspect(desktop);
await desktop.screenshot({ path: `${out}/en-desktop.png`, fullPage: true });
console.log('EN desktop:', JSON.stringify(en));

// The two tiles that used to be grey boxes.
const tiles = await desktop.evaluate(() =>
  Array.from(document.querySelectorAll('.destination-tile'))
    .map((tile) => {
      const img = tile.querySelector('img');
      const name = tile.querySelector('.destination-name')?.textContent?.trim() ?? '';
      return {
        name,
        hasImg: Boolean(img),
        loaded: img ? img.complete && img.naturalWidth > 0 : false,
        naturalWidth: img?.naturalWidth ?? 0,
      };
    })
    .filter((t) => ['Florence', 'Madrid', 'Rome', 'Venice'].includes(t.name)),
);
console.log('destination tiles:', JSON.stringify(tiles));

// --- Chinese desktop --------------------------------------------------------
const zh = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await zh.context().addCookies([{ name: 'easytrip_lang', value: 'zh', url: base }]);
await zh.goto(base, { waitUntil: 'domcontentloaded' });
await zh.waitForTimeout(2500);
const zhReport = await inspect(zh);
await zh.screenshot({ path: `${out}/zh-desktop.png`, fullPage: true });
console.log('ZH desktop:', JSON.stringify(zhReport));

// --- Mobile -----------------------------------------------------------------
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForTimeout(2500);
const mob = await inspect(mobile);
await mobile.screenshot({ path: `${out}/en-mobile.png`, fullPage: true });
console.log('EN mobile:', JSON.stringify(mob));

await browser.close();
console.log(`\nscreenshots → ${out}`);
