import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Measures the product ribbon against the thumbnail it sits on.
 *
 * The complaint is that a white label covers most of the image at phone width.
 * This quantifies it — coverage percentage, and the geometry of each element —
 * so the fix can be judged rather than eyeballed.
 *
 *   node scripts/ux-audit/diagnose-card-ribbon.mjs
 */
mkdirSync('artifacts/verify', { recursive: true });

const browser = await chromium.launch();

for (const [label, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, deviceScaleFactor: 2 });
  await page.goto('http://localhost:3000/search', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const report = await page.evaluate(() => {
    const geometry = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        fontSize: style.fontSize,
        padding: style.padding,
        position: style.position,
      };
    };

    const card = document.querySelector('.product-card');
    if (!card) return { error: 'no .product-card found' };

    const media = card.querySelector('.product-media');
    const ribbon = card.querySelector('.product-ribbon');

    const mediaRect = media?.getBoundingClientRect();
    const ribbonRect = ribbon?.getBoundingClientRect();
    const coverage =
      mediaRect && ribbonRect
        ? Math.round(((ribbonRect.width * ribbonRect.height) / (mediaRect.width * mediaRect.height)) * 100)
        : null;

    return {
      cardColumns: getComputedStyle(card).gridTemplateColumns,
      card: geometry(card),
      media: geometry(media),
      img: geometry(media?.querySelector('img')),
      ribbon: geometry(ribbon),
      ribbonText: ribbon?.textContent ?? null,
      ribbonLines: ribbon ? Math.round(ribbonRect.height / (parseFloat(getComputedStyle(ribbon).fontSize) * 1.4)) : null,
      coveragePercent: coverage,
    };
  });

  console.log(`\n── ${label} (${viewport.width}px) ──`);
  console.log(JSON.stringify(report, null, 1));

  await page.locator('.product-card').first().screenshot({ path: `artifacts/verify/card-${label}.png` }).catch(() => undefined);
  await page.close();
}

await browser.close();
