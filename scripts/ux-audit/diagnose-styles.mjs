import { chromium } from 'playwright';

/**
 * Reports the computed styles behind two visible defects:
 *   1. the "Explore destinations" subtitle, which renders almost invisible
 *   2. the body font, and which CJK families are actually available
 */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.env.WEB_URL ?? 'http://localhost:3000', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const out = {};

  // The subtitle next to the "Explore destinations" heading.
  const h2 = Array.from(document.querySelectorAll('h2')).find((n) => /Explore destinations/i.test(n.textContent ?? ''));
  const wrap = h2?.parentElement?.parentElement ?? h2?.parentElement;
  const para = wrap?.querySelector('p');

  const describe = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Walk up for the first opaque background, to compute real contrast.
    let bg = 'rgba(0, 0, 0, 0)';
    for (let n = el; n; n = n.parentElement) {
      const b = getComputedStyle(n).backgroundColor;
      if (b && b !== 'rgba(0, 0, 0, 0)' && !b.endsWith(', 0)')) { bg = b; break; }
    }
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.getAttribute('class') ?? '',
      color: s.color,
      backgroundChain: bg,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily.slice(0, 90),
      width: Math.round(r.width),
      text: (el.textContent ?? '').trim().slice(0, 70),
    };
  };

  out.destinationsHeading = describe(h2);
  out.destinationsSubtitle = describe(para);

  // Body font + CJK availability.
  out.body = describe(document.body);
  out.fontsAvailable = {
    notoSansSC: document.fonts.check('16px "Noto Sans SC"'),
    pingFang: document.fonts.check('16px "PingFang SC"'),
    yaHei: document.fonts.check('16px "Microsoft YaHei"'),
    sourceHanSans: document.fonts.check('16px "Source Han Sans SC"'),
    inter: document.fonts.check('16px "Inter"'),
  };
  out.cjkFallback = document.fonts.check('16px "Noto Sans SC", "PingFang SC", sans-serif');

  // Any element whose text colour is nearly the same as its background.
  const lowContrast = [];
  const parse = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const lum = ([r, g, b]) => {
    const a = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  };
  for (const el of Array.from(document.querySelectorAll('p, span, div, li, h1, h2, h3'))) {
    const text = (el.textContent ?? '').trim();
    if (text.length < 12 || el.children.length > 0) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 20) continue;
    const fg = parse(s.color);
    let bg = 'rgba(0, 0, 0, 0)';
    for (let n = el; n; n = n.parentElement) {
      const b = getComputedStyle(n).backgroundColor;
      if (b && !b.endsWith(', 0)') && b !== 'rgba(0, 0, 0, 0)') { bg = b; break; }
    }
    const bgc = parse(bg);
    if (fg.length < 3 || bgc.length < 3) continue;
    const ratio = (Math.max(lum(fg), lum(bgc)) + 0.05) / (Math.min(lum(fg), lum(bgc)) + 0.05);
    if (ratio < 2.2) {
      lowContrast.push({ ratio: Number(ratio.toFixed(2)), color: s.color, bg, cls: (el.getAttribute('class') ?? '').slice(0, 40), text: text.slice(0, 50) });
    }
  }
  out.lowContrastCount = lowContrast.length;
  out.lowContrastSample = lowContrast.slice(0, 10);

  return out;
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
