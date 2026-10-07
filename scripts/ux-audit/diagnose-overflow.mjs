import { chromium } from 'playwright';

/**
 * Overflow diagnostic — `node scripts/ux-audit/diagnose-overflow.mjs [url] [width]`.
 *
 * The render audit reports *that* a container overflows; this reports *which*
 * element causes it. It walks the DOM at a narrow viewport and lists every
 * element wider than the viewport, sorted shallowest-first, so the outermost
 * offender (the one to actually fix) is at the top.
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const target = process.argv[2] ?? null;
const width = Number(process.argv[3] ?? 393);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 851 } });

let url = target;
if (!url) {
  await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
  const href = await page.locator('a[href^="/products/"]').first().getAttribute('href');
  url = href ?? '/';
}
await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
console.log(`page: ${base}${url} @ ${width}px wide`);

const report = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const rows = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const rect = el.getBoundingClientRect();
    if (rect.right <= vw + 1 && rect.width <= vw + 1) continue;
    const style = getComputedStyle(el);
    let depth = 0;
    for (let n = el; n.parentElement; n = n.parentElement) depth += 1;
    rows.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.getAttribute('class') ?? '').slice(0, 70),
      w: Math.round(rect.width),
      right: Math.round(rect.right),
      overflowX: style.overflowX,
      display: style.display,
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
      depth,
    });
  }
  return { vw, rows: rows.sort((a, b) => a.depth - b.depth).slice(0, 30) };
});

console.log(`viewport=${report.vw}`);
for (const row of report.rows) {
  console.log(
    `d=${String(row.depth).padStart(2)} w=${String(row.w).padStart(4)} right=${String(row.right).padStart(4)} ovf=${row.overflowX.padEnd(7)} ${row.tag}.${row.cls} | ${row.text}`,
  );
}

await browser.close();
