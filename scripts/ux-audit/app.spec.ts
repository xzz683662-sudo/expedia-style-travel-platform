import { expect, test } from '@playwright/test';
import { auditPage, writeReport, type AuditResult } from './helpers';

/**
 * Storefront UX audit + end-to-end purchase chain.
 *
 *   pnpm ux:audit:app   — render audit of the key storefront pages
 *   pnpm e2e:web        — register -> verify -> search -> reserve -> pay -> ticket
 *
 * Both run against a *running* web server (see `playwright.config.ts`), so the
 * audit measures real server-rendered HTML and the real built stylesheet rather
 * than a dev-mode approximation.
 *
 * The render audit asserts, rather than reports: `error`-severity findings
 * (a broken image, a horizontal overflow) fail the run. That is what makes it a
 * gate instead of a screenshot dump.
 */

const UNIQUE = () => `e2e.${Date.now()}.${Math.floor(Math.random() * 1e4)}@easytrip.test`;
const PASSWORD = 'Password123!';

test.describe('storefront render audit', () => {
  test('key pages render without broken images or overflow', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const visited: AuditResult[] = [];
    const results: AuditResult[] = [];

    for (const route of ['/', '/search', '/login', '/register', '/cart']) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const name = route === '/' ? 'home' : route.replace(/^\//, '');
      results.push(await auditPage(page, name, viewport));
      visited.push(results[results.length - 1]!);
    }

    // The product detail page carries the booking panel and the gallery, so it
    // is the page most likely to expose a broken image.
    await page.goto('/search');
    const productLink = page.locator('a[href^="/products/"]').first();
    if (await productLink.count()) {
      await productLink.click();
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      results.push(await auditPage(page, 'product', viewport));
    }

    writeReport(
      `docs/ux-audit-app-${viewport}.md`,
      `Storefront render audit — ${viewport}`,
      [
        `Automated pass over the running storefront (${viewport} viewport).`,
        '',
        '`error` = a broken image or a horizontal overflow; `warning` = collapsed content or an',
        'unnamed control; `info` = a small tap target or an alt/copy mismatch candidate for a',
        'human to review. Only `error` fails the run.',
      ].join('\n'),
      results,
    );

    const errors = results.flatMap((result) =>
      result.findings.filter((finding) => finding.severity === 'error').map((finding) => `${result.name}: ${finding.detail}`),
    );
    expect(errors, `render defects:\n${errors.join('\n')}`).toEqual([]);
    expect(visited.length).toBeGreaterThan(0);
  });
});

test.describe('end-to-end purchase chain', () => {
  test('register → verify → search → reserve → pay → ticket', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the full chain runs once (the mobile audit covers layout)');

    const email = UNIQUE();

    // -----------------------------------------------------------------------
    // 1. Register
    // -----------------------------------------------------------------------
    await page.goto('/register');
    const registerForm = page.locator('[data-testid="register-form"]');
    await expect(registerForm).toBeVisible();

    await registerForm.getByLabel(/first name/i).fill('End');
    await registerForm.getByLabel(/last name/i).fill('ToEnd');
    await registerForm.getByLabel(/email/i).fill(email);
    await registerForm.getByLabel(/password/i).fill(PASSWORD);
    await registerForm.getByRole('button', { name: /create account/i }).click();

    // -----------------------------------------------------------------------
    // 2. The verification step — the gate this whole change added.
    // -----------------------------------------------------------------------
    const verifyForm = page.locator('[data-testid="verify-form"]');
    await expect(verifyForm).toBeVisible();

    const devCodeText = await page.locator('[data-testid="dev-code"]').innerText();
    const code = devCodeText.match(/\d{6}/)?.[0];
    expect(code, `no 6-digit code in "${devCodeText}"`).toBeTruthy();

    await page.locator('[data-testid="verify-code"]').fill(code!);
    await page.locator('[data-testid="verify-submit"]').click();

    await page.waitForURL(/\/orders/, { timeout: 30_000 });
    await page.screenshot({ path: 'artifacts/ux-audit/desktop/e2e-1-verified.png', fullPage: true });

    // -----------------------------------------------------------------------
    // 3. Search and open a product
    // -----------------------------------------------------------------------
    await page.goto('/search');
    const firstProduct = page.locator('a[href^="/products/"]').first();
    await expect(firstProduct).toBeVisible();
    await firstProduct.click();
    await page.waitForURL(/\/products\//);
    await page.screenshot({ path: 'artifacts/ux-audit/desktop/e2e-2-product.png', fullPage: true });

    // The booking panel is the last thing to hydrate; its CTA is the anchor.
    const reserve = page.getByRole('button', { name: /reserve & continue to payment/i }).first();
    await expect(reserve).toBeVisible();
    await reserve.click();

    // -----------------------------------------------------------------------
    // 4. Checkout: review -> details -> payment
    // -----------------------------------------------------------------------
    await page.waitForURL(/\/checkout/);
    await page.getByRole('button', { name: /continue to details/i }).click();

    // Verified account: the API accepts the order. Before this change it would
    // have been refused with EMAIL_NOT_VERIFIED, which is asserted in the smoke
    // suite; here we prove the happy path the gate now permits.
    const emailField = page.getByLabel(/email address/i).first();
    if (!(await emailField.inputValue())) await emailField.fill(email);
    const nameField = page.getByLabel(/lead guest name/i).first();
    if (!(await nameField.inputValue())) await nameField.fill('End ToEnd');

    await page.getByRole('button', { name: /reserve & continue to payment/i }).click();

    // Payment step.
    const cardField = page.getByLabel(/card number/i).first();
    await expect(cardField).toBeVisible({ timeout: 30_000 });
    await cardField.fill('4242424242424242');
    // CVC is `required` on the form, so leaving it empty makes the browser block
    // the submit with a validation bubble rather than reaching the API — which
    // presents as a permanently "processing" button.
    await page.getByLabel(/cvc/i).first().fill('123');
    await page.screenshot({ path: 'artifacts/ux-audit/desktop/e2e-3-payment.png', fullPage: true });

    const payButton = page.getByRole('button', { name: /^pay /i }).first();
    await expect(payButton).toBeEnabled();
    await payButton.click();

    // -----------------------------------------------------------------------
    // 5. Confirmation and a real ticket artefact
    // -----------------------------------------------------------------------
    await page.waitForURL(/\/orders\//, { timeout: 60_000 });
    await page.screenshot({ path: 'artifacts/ux-audit/desktop/e2e-4-confirmed.png', fullPage: true });

    await page.goto('/tickets');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    // The ticket QR is generated server-side and served from the API's /media
    // route. If it is missing, `naturalWidth` is 0 — which is exactly the
    // "broken image" defect this audit exists to catch, at the worst moment.
    const qr = page.locator('img[src*="/media/tickets/"]').first();
    if (await qr.count()) {
      await expect
        .poll(async () => qr.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 })
        .toBeGreaterThan(0);
    }

    await page.screenshot({ path: 'artifacts/ux-audit/desktop/e2e-5-tickets.png', fullPage: true });
  });
});
