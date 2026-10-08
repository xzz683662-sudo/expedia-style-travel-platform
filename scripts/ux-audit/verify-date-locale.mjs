import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Confirms the date-input locale fix on the real page.
 *
 * The browser is launched with a **Chinese** locale on purpose: that is the
 * configuration in which the defect appeared (an English page showing `年月日`).
 * The screenshot is the only way to observe a native control's placeholder, so
 * one is written per locale.
 *
 *   node scripts/ux-audit/verify-date-locale.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const out = 'artifacts/verify';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

for (const browserLocale of ['zh-CN', 'en-US']) {
  const context = await browser.newContext({ locale: browserLocale, viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  // The defect is "English page, Chinese date field". Force the *app* locale to
  // English while the *browser* stays Chinese — otherwise Accept-Language turns
  // the whole page Chinese and the case under test never occurs.
  await context.addCookies([{ name: 'easytrip_lang', value: 'en', url: base }]);
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const input = document.querySelector('input[type="date"]');
    return {
      htmlLang: document.documentElement.lang,
      inputLang: input?.getAttribute('lang') ?? null,
      heading: document.querySelector('h1')?.textContent?.slice(0, 40) ?? '',
    };
  });

  console.log(`browser=${browserLocale} → ${JSON.stringify(info)}`);
  await page.locator('input[type="date"]').first().screenshot({ path: `${out}/date-field-browser-${browserLocale}.png` }).catch(() => undefined);
  await context.close();
}

await browser.close();
console.log(`\n→ ${out}`);
