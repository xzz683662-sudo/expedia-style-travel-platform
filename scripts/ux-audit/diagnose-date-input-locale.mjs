import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Does the `lang` attribute change how Chromium renders a native date input?
 *
 * A `<input type="date">` shows its format placeholder in the *browser* locale,
 * not the page locale — so an English page in a Chinese-locale browser shows
 * `yyyy/mm/日期`. This measures whether `lang` is enough to fix it, because
 * guessing wrong here means shipping a fix that changes nothing.
 *
 *   node scripts/ux-audit/diagnose-date-input-locale.mjs
 */
mkdirSync('artifacts/verify', { recursive: true });

const browser = await chromium.launch();

// Deliberately launch with a Chinese locale, matching the reporter's browser.
for (const browserLocale of ['zh-CN', 'en-US']) {
  const context = await browser.newContext({ locale: browserLocale, viewport: { width: 420, height: 220 }, deviceScaleFactor: 3 });
  const page = await context.newPage();

  await page.setContent(`
    <html lang="en">
      <body style="font:16px system-ui;padding:12px;background:#fff">
        <div>html lang="en"</div>
        <div style="margin:8px 0">
          <div>no lang attr:</div><input type="date" id="a">
        </div>
        <div style="margin:8px 0">
          <div>lang="en-US":</div><input type="date" id="b" lang="en-US">
        </div>
        <div style="margin:8px 0">
          <div>lang="zh-CN":</div><input type="date" id="c" lang="zh-CN">
        </div>
      </body>
    </html>
  `);

  await page.waitForTimeout(300);
  await page.screenshot({ path: `artifacts/verify/date-input-${browserLocale}.png` });

  // The DOM value is always ISO; only the *rendered* placeholder differs, so a
  // screenshot is the only way to observe it. Record what we can measure too.
  const info = await page.evaluate(() => ({
    navigatorLanguage: navigator.language,
    resolvedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    inputs: ['a', 'b', 'c'].map((id) => {
      const el = document.getElementById(id);
      return { id, lang: el.getAttribute('lang'), type: el.type, value: el.value };
    }),
  }));
  console.log(browserLocale, JSON.stringify(info));
  await context.close();
}

await browser.close();
console.log('\nscreenshots → artifacts/verify/date-input-*.png');
