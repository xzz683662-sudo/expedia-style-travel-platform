import { test } from '@playwright/test';
import { auditPage, looksLikeBotWall, writeReport, type AuditResult } from './helpers';

/**
 * Reference-site audit — `pnpm ux:audit:reference`.
 *
 * Audits expedia.com as a design reference: missing images, layout overflow,
 * collapsed content, unnamed controls, and alt/copy mismatches. It reports; it
 * does not gate. Two reasons:
 *
 *   1. The defects belong to someone else's site, and a red run here would say
 *      nothing about this repository.
 *   2. The site may serve an anti-bot interstitial. When it does, the honest
 *      outcome is a report that says so — not a green run that implies the page
 *      was inspected, and not a red one that blames our code.
 *
 * Output: `docs/ux-audit-reference.md` plus screenshots under
 * `artifacts/ux-audit/desktop/`.
 */

const REFERENCE_URL = process.env.REFERENCE_URL ?? 'https://www.expedia.com/';

test.describe('reference site (expedia.com)', () => {
  test('homepage renders and the main sections respond', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the reference audit runs once (desktop viewport)');

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
    });

    await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Best effort only: a page with continuous analytics beacons never reaches
    // networkidle, and waiting for it would burn the whole timeout.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    if (await looksLikeBotWall(page)) {
      writeReport(
        'docs/ux-audit-reference.md',
        'Reference site audit — expedia.com',
        [
          '## Result: blocked by an anti-bot interstitial',
          '',
          `The audit reached \`${REFERENCE_URL}\` but the response was a bot challenge, not the`,
          'storefront. No rendering signals could be collected, so no findings are recorded.',
          '',
          'This is expected for an automated browser against a large commercial site and is not',
          'a defect in this repository. To audit the reference manually, open the URL in a normal',
          'browser and compare against the checklist in this file.',
          '',
          '**Checklist for the manual pass** (the same signals the automated audit measures):',
          '',
          '- Every image renders (no empty boxes where a thumbnail should be).',
          '- No section overflows the viewport horizontally; no clipped text.',
          '- Headings, nav and tabs respond on click, on desktop and at 390px.',
          '- Card copy matches its image (a photo of a beach under "city walking tour" is a defect).',
          '- The primary search form is usable end to end without a layout jump.',
        ].join('\n'),
        [],
      );
      testInfo.skip(true, 'reference site served an anti-bot interstitial');
      return;
    }

    // Common consent dialogs. Failure to dismiss one is not a finding.
    for (const name of [/accept all/i, /accept/i, /got it/i, /close/i]) {
      const button = page.getByRole('button', { name }).first();
      try {
        if (await button.isVisible({ timeout: 1500 })) {
          await button.click({ timeout: 2000 });
          break;
        }
      } catch {
        /* no such dialog */
      }
    }

    const results: AuditResult[] = [];
    results.push(await auditPage(page, 'home', 'desktop'));

    // Exercise the primary navigation without leaving the origin.
    const navTargets = ['Flights', 'Stays', 'Cars', 'Packages'];
    for (const label of navTargets) {
      const tab = page.getByRole('tab', { name: label }).or(page.getByRole('link', { name: label })).first();
      try {
        if (await tab.isVisible({ timeout: 1500 })) {
          await tab.click({ timeout: 3000 });
          await page.waitForTimeout(800);
          results.push(await auditPage(page, `tab-${label.toLowerCase()}`, 'desktop'));
        }
      } catch {
        /* the tab moved or is not present — recorded as absent, not as a failure */
      }
    }

    writeReport(
      'docs/ux-audit-reference.md',
      'Reference site audit — expedia.com',
      [
        `Automated pass over \`${REFERENCE_URL}\` with a headless Chromium at 1440×900.`,
        '',
        'Findings are recorded against the reference only; nothing here gates this repository.',
        '`error` = a broken image or a horizontal overflow; `warning` = collapsed content or an',
        'unnamed control; `info` = a small tap target or an alt/copy mismatch candidate that a',
        'human should eyeball.',
        '',
        `Console errors observed: ${consoleErrors.length === 0 ? 'none' : consoleErrors.length}.`,
      ].join('\n'),
      results,
    );

    test.info().annotations.push({
      type: 'reference-findings',
      description: results.map((r) => `${r.name}: ${r.counts.error}e/${r.counts.warning}w/${r.counts.info}i`).join(', '),
    });
  });
});
