import { chromium } from 'playwright';

/** Measures the min-content width of candidate multi-column blocks. */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const width = Number(process.argv[3] ?? 393);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 851 } });

let url = process.argv[2];
if (!url) {
  await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
  url = (await page.locator('a[href^="/products/"]').first().getAttribute('href')) ?? '/';
}
await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });

const rows = await page.evaluate(() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const style = getComputedStyle(el);
    if (style.display !== 'grid' && style.display !== 'flex') continue;
    if (style.flexWrap === 'wrap' && style.display === 'flex') continue;
    const rect = el.getBoundingClientRect();
    const prev = el.style.width;
    el.style.width = 'min-content';
    const minContent = Math.round(el.getBoundingClientRect().width);
    el.style.width = prev;
    if (minContent <= 393) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') ?? '').slice(0, 55),
      display: style.display,
      cols: style.gridTemplateColumns.slice(0, 60),
      w: Math.round(rect.width),
      minContent,
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 45),
    });
  }
  return out.sort((a, b) => b.minContent - a.minContent).slice(0, 12);
});

console.log(`page: ${base}${url} @ ${width}px — grid/flex blocks whose min-content exceeds the viewport`);
for (const row of rows) {
  console.log(`minContent=${String(row.minContent).padStart(4)} w=${String(row.w).padStart(4)} ${row.display.padEnd(5)} cols="${row.cols}" ${row.tag}.${row.cls} | ${row.text}`);
}

await browser.close();
