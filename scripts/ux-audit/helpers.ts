import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * ---------------------------------------------------------------------------
 * Shared browser-audit helpers
 * ---------------------------------------------------------------------------
 *
 * What "the page renders correctly" means, made mechanical. Each check targets
 * a failure mode that screenshots alone tend to hide:
 *
 *   - **Broken images.** A missing asset renders as empty space in a thumbnail
 *     and is easy to miss by eye. `naturalWidth === 0` on a *complete* image is
 *     unambiguous.
 *   - **Overflow.** A container whose content is wider than itself with
 *     `overflow-x: visible` is either a layout bug or clipped text.
 *   - **Zero-height content.** Text that exists in the DOM but occupies no
 *     space (a collapsed flex child, a display:none ancestor that should not be
 *     one) is invisible to a screenshot review.
 *   - **Tap targets.** On mobile, an interactive control under ~32px is a real
 *     usability defect, not a style preference.
 *   - **Alt/text mismatch.** Purely a *heuristic*: an image whose `alt` shares no
 *     significant word with the copy around it is flagged for a human to look
 *     at. It cannot prove a mismatch, so it never fails a build.
 */

export type Severity = 'error' | 'warning' | 'info';

export type Finding = {
  kind: string;
  severity: Severity;
  detail: string;
};

export type AuditResult = {
  name: string;
  url: string;
  title: string;
  screenshot: string;
  findings: Finding[];
  counts: Record<Severity, number>;
};

export const ARTIFACTS_DIR = 'artifacts/ux-audit';

type RawFindings = {
  brokenImages: string[];
  overflow: string[];
  emptyText: string[];
  tinyTargets: string[];
  altMismatch: string[];
  unlabeledControls: string[];
};

/** Screen-space audit. Self-contained: Playwright serialises this into the page. */
function collectInPage(viewportWidth: number): RawFindings {
  const out: RawFindings = {
    brokenImages: [],
    overflow: [],
    emptyText: [],
    tinyTargets: [],
    altMismatch: [],
    unlabeledControls: [],
  };

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.');
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `${tag}${cls ? `.${cls}` : ''}${text ? ` "${text}"` : ''}`;
  };

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };

  // 1. Broken images. The origin is recorded so the reporter can separate
  //    "our asset is missing" from "an external host is unreachable here".
  for (const img of Array.from(document.images)) {
    if (!isVisible(img)) continue;
    const src = img.currentSrc || img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') ?? '';
    let origin = 'same-origin';
    try {
      if (src && new URL(src, location.href).origin !== location.origin) origin = 'cross-origin';
    } catch {
      /* not a URL we can parse; treat as same-origin and let it fail loudly */
    }
    if (!src) out.brokenImages.push(`same-origin <img> with no src (alt="${alt}")`);
    else if (img.complete && img.naturalWidth === 0) {
      out.brokenImages.push(`${origin} ${src} — naturalWidth=0 (alt="${alt}")`);
    }
  }

  // 2. Horizontal overflow with no scroll affordance.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (out.overflow.length >= 12) break;
    const style = getComputedStyle(el);
    if (style.overflowX !== 'visible' || style.position === 'fixed') continue;
    if (el.clientWidth === 0) continue;
    const text = (el.textContent ?? '').trim();
    if (text.length < 10) continue;
    if (el.scrollWidth > el.clientWidth + 4) {
      out.overflow.push(`${describe(el)} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
    }
  }

  // 3. Content that occupies no space.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('section, article, li, h1, h2, h3, p, button, a'))) {
    if (out.emptyText.length >= 12) break;
    const text = (el.textContent ?? '').trim();
    if (text.length < 3) continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // Ignore genuinely hidden things; flag things that are "shown" with no box.
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.height < 1 && rect.width > 0) out.emptyText.push(`${describe(el)} height=${rect.height}`);
  }

  // 4. Small tap targets (mobile only — desktop uses a pointer).
  if (viewportWidth <= 500) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input[type="submit"], [role="button"]'))) {
      if (out.tinyTargets.length >= 15) break;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      // Inline links inside prose are exempt: they are text, not controls.
      if (getComputedStyle(el).display === 'inline') continue;
      if (rect.height < 32 || rect.width < 32) {
        out.tinyTargets.push(`${describe(el)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
  }

  // 5. Controls with no accessible name.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input:not([type="hidden"]), select, textarea'))) {
    if (out.unlabeledControls.length >= 12) break;
    if (!isVisible(el)) continue;
    const named =
      (el.getAttribute('aria-label') ?? '').trim() ||
      (el.getAttribute('title') ?? '').trim() ||
      (el.textContent ?? '').trim() ||
      (el as HTMLInputElement).placeholder ||
      (el.getAttribute('alt') ?? '') ||
      // An input wrapped in a <label> takes its name from that label.
      (el.closest('label')?.textContent ?? '').trim();
    if (!named) out.unlabeledControls.push(describe(el));
  }

  // 6. Alt/copy mismatch heuristic.
  const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'your', 'our', 'its', 'are', 'you', 'get', 'all', 'new']);
  const tokens = (value: string): string[] =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP.has(word));

  for (const img of Array.from(document.images)) {
    if (out.altMismatch.length >= 10) break;
    if (!isVisible(img)) continue;
    const alt = (img.getAttribute('alt') ?? '').trim();
    if (alt.length < 12) continue;
    const container = img.closest('article, section, li, div');
    const around = (container?.textContent ?? '').replace(alt, '').trim();
    if (around.length < 12) continue;
    const altWords = tokens(alt);
    const aroundWords = new Set(tokens(around));
    if (altWords.length === 0) continue;
    if (!altWords.some((word) => aroundWords.has(word))) {
      out.altMismatch.push(`alt="${alt.slice(0, 70)}" vs nearby copy "${around.replace(/\s+/g, ' ').slice(0, 70)}"`);
    }
  }

  return out;
}

/** Runs the audit, screenshots the page, and returns structured findings. */
export async function auditPage(page: Page, name: string, viewport: string): Promise<AuditResult> {
  const dir = join(ARTIFACTS_DIR, viewport);
  mkdirSync(dir, { recursive: true });
  const screenshot = join(dir, `${name}.png`);

  const width = page.viewportSize()?.width ?? 1440;
  let raw: RawFindings;
  try {
    raw = await page.evaluate(collectInPage, width);
  } catch (error) {
    raw = {
      brokenImages: [`audit failed to run: ${(error as Error).message}`],
      overflow: [],
      emptyText: [],
      tinyTargets: [],
      altMismatch: [],
      unlabeledControls: [],
    };
  }

  // Best-effort full-page screenshot: a very tall page can exceed the limit.
  try {
    await page.screenshot({ path: screenshot, fullPage: true });
  } catch {
    await page.screenshot({ path: screenshot });
  }

  const findings: Finding[] = [
    ...raw.brokenImages.map((detail) => ({
      // A same-origin asset that fails to load is our bug. A third-party CDN
      // image is not: in a sandboxed CI container outbound requests to image
      // hosts are commonly blocked, and reporting that as an application error
      // would make the gate permanently red for an environmental reason.
      kind: detail.includes('same-origin') ? 'broken-image' : 'external-image-unreachable',
      severity: (detail.includes('same-origin') ? 'error' : 'warning') as Severity,
      detail,
    })),
    ...raw.overflow.map((detail) => ({ kind: 'horizontal-overflow', severity: 'error' as const, detail })),
    ...raw.emptyText.map((detail) => ({ kind: 'collapsed-content', severity: 'warning' as const, detail })),
    ...raw.unlabeledControls.map((detail) => ({ kind: 'unnamed-control', severity: 'warning' as const, detail })),
    ...raw.tinyTargets.map((detail) => ({ kind: 'small-tap-target', severity: 'info' as const, detail })),
    ...raw.altMismatch.map((detail) => ({ kind: 'alt-copy-mismatch?', severity: 'info' as const, detail })),
  ];

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    name,
    url: page.url(),
    title: await page.title().catch(() => ''),
    screenshot,
    findings,
    counts,
  };
}

/** Writes a Markdown report for a set of audit results. */
export function writeReport(path: string, heading: string, intro: string, results: AuditResult[]): void {
  const lines: string[] = [`# ${heading}`, '', intro, ''];

  const totals = { error: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const result of results) {
    totals.error += result.counts.error;
    totals.warning += result.counts.warning;
    totals.info += result.counts.info;
  }

  lines.push(
    `**Summary:** ${totals.error} error(s), ${totals.warning} warning(s), ${totals.info} informational.`,
    '',
    '| Page | Errors | Warnings | Info | Screenshot |',
    '| --- | ---: | ---: | ---: | --- |',
  );
  for (const result of results) {
    lines.push(`| ${result.name} | ${result.counts.error} | ${result.counts.warning} | ${result.counts.info} | \`${result.screenshot}\` |`);
  }

  for (const result of results) {
    lines.push('', `## ${result.name}`, '', `- URL: \`${result.url}\``, `- Title: ${result.title || '(none)'}`);
    if (result.findings.length === 0) {
      lines.push('- No findings.', '');
      continue;
    }
    lines.push('');
    for (const finding of result.findings) {
      lines.push(`- **${finding.severity}** · \`${finding.kind}\` — ${finding.detail}`);
    }
    lines.push('');
  }

  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

/** True when the page looks like an anti-bot interstitial rather than the site. */
export async function looksLikeBotWall(page: Page): Promise<boolean> {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  const title = (await page.title().catch(() => '')).toLowerCase();
  const haystack = `${title}\n${body.slice(0, 4000)}`;
  return (
    haystack.includes('bot or not') ||
    haystack.includes('are you a robot') ||
    haystack.includes('unusual traffic') ||
    haystack.includes('captcha') ||
    haystack.includes('access denied') ||
    haystack.includes('enable javascript and cookies')
  );
}
