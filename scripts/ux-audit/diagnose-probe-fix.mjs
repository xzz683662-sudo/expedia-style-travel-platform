import { chromium } from 'playwright';

/**
 * Empirical overflow fixer.
 *
 * Given a page and a viewport, tries a list of candidate CSS patches and
 * reports whether the document still overflows. Faster and more reliable than
 * reasoning about flexbox min-content contributions: the browser is the
 * authority on why a page is wider than its viewport.
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const url = process.argv[2] ?? '/products/top-view-observation-deck';
const width = Number(process.argv[3] ?? 393);

const CANDIDATES = [
  ['none', ''],
  ['align-items: stretch (<=860)', '@media (max-width: 860px){ .with-rail { align-items: stretch; } }'],
  ['align-items: stretch (always)', '.with-rail { align-items: stretch; }'],
  ['similar-card wrap only', '.card.card-hover.row { flex-wrap: wrap; }'],
  ['calendar scroll only', '.calendar { overflow-x: auto; }'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 851 } });
await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });

for (const [label, css] of CANDIDATES) {
  const result = await page.evaluate(([cssText]) => {
    document.querySelectorAll('style[data-probe]').forEach((n) => n.remove());
    if (cssText) {
      const style = document.createElement('style');
      style.setAttribute('data-probe', '1');
      style.textContent = cssText;
      document.head.appendChild(style);
    }
    // `body` hides its own horizontal overflow, so `documentElement.scrollWidth`
    // is always the viewport width and proves nothing. `body.scrollWidth` is the
    // real measure of how far the content actually extends.
    const offenders = [];
    const vw = document.documentElement.clientWidth;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1) offenders.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').slice(0, 40)}`);
    }
    return { scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth, offenders: offenders.slice(0, 4) };
  }, [css]);

  const fixed = result.scrollWidth <= result.clientWidth + 1;
  console.log(`${fixed ? 'FIXED ' : 'still '} ${label.padEnd(28)} scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}${result.offenders.length ? ` e.g. ${result.offenders.join(', ')}` : ''}`);
}

await browser.close();
