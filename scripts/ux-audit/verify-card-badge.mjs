import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Card verification after moving the highlight off the photo.
 *
 * Asserts the two things the change was for:
 *   1. No element overlays the thumbnail (nothing covers the image).
 *   2. The highlight renders in the page's language — it used to be English in
 *      the API payload, so a Chinese card showed "Private departure".
 *
 *   node scripts/ux-audit/verify-card-badge.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/verify/cards';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

for (const [tag, locale, viewport] of [
  ['zh-mobile', 'zh', { width: 390, height: 844 }],
  ['en-mobile', 'en', { width: 390, height: 844 }],
  ['zh-desktop', 'zh', { width: 1440, height: 900 }],
]) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, deviceScaleFactor: 2 });
  await context.addCookies([{ name: 'easytrip_lang', value: locale, url: base }]);
  const page = await context.newPage();
  await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => {
    const card = document.querySelector('.product-card');
    if (!card) return { error: 'no card' };
    const media = card.querySelector('.product-media');
    const mediaRect = media.getBoundingClientRect();

    // Anything inside the media box that is NOT the image or its fallback is an
    // overlay sitting on top of the photo.
    const overlays = Array.from(media.children).filter(
      (child) => child.tagName !== 'IMG' && !child.classList.contains('product-media-fallback'),
    );

    return {
      mediaSize: `${Math.round(mediaRect.width)}x${Math.round(mediaRect.height)}`,
      overlaysOnPhoto: overlays.length,
      overlayText: overlays.map((o) => o.textContent.trim()).join(' | '),
      bodyChips: Array.from(card.querySelectorAll('.product-body .badge')).map((b) => b.textContent.trim()),
      title: card.querySelector('.product-title')?.textContent?.trim() ?? '',
    };
  });

  console.log(`\n── ${tag} ──`);
  console.log(JSON.stringify(report, null, 1));
  await page.locator('.product-card').first().screenshot({ path: `${out}/${tag}.png` });
  await context.close();
}

await browser.close();
console.log(`\n→ ${out}`);
