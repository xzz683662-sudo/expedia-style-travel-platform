import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Drives the wallet UI end to end in a real browser and screenshots it.
 *
 * Registers a throwaway account, signs the browser in, then exercises
 * top-up and withdraw through the actual form — so this proves the *UI* works,
 * not just the endpoint.
 *
 *   node scripts/ux-audit/verify-wallet-ui.mjs
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const api = 'http://localhost:4000/api/v1';
const password = 'Password123' + String.fromCharCode(33);
const out = 'artifacts/verify/wallet';
mkdirSync(out, { recursive: true });

const post = (path, body, token) =>
  fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const email = `ui.wallet.${Date.now()}@easytrip.test`;
const reg = await post('/auth/register', { email, password, firstName: 'Wallet', lastName: 'UI' });
await post('/auth/verify-email', { email, code: reg.emailVerification.devCode });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
page.on('response', (r) => {
  const url = r.url();
  if (url.includes('/account/wallet') && r.request().method() !== 'GET') {
    console.log(`  [net] ${r.request().method()} ${url.split('/api/v1')[1]} → ${r.status()}`);
  }
});

await page.goto(base, { waitUntil: 'domcontentloaded' });
// The session keys are `easytrip_token` / `easytrip_user` — see lib/session.ts.
// Guessing them wrong makes `readToken()` return null, and the account page then
// renders its signed-out state, which looks like the feature is missing.
await page.evaluate(([t, u]) => {
  localStorage.setItem('easytrip_token', t);
  localStorage.setItem('easytrip_user', JSON.stringify({ id: 'x', email: u, firstName: 'Wallet', lastName: 'UI' }));
}, [reg.token, email]);

await page.goto(`${base}/account`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Locale the app to Chinese so the labels read 充值 / 取现, matching the request.
await page.context().addCookies([{ name: 'easytrip_lang', value: 'zh', url: base }]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const balanceCard = page.locator('section', { hasText: '余额' }).first();
await balanceCard.screenshot({ path: `${out}/1-empty.png` });
console.log('1. empty state captured');

// --- Top up -----------------------------------------------------------------
await page.getByRole('button', { name: '充值' }).first().click();
await page.waitForTimeout(300);
await page.getByLabel('金额').fill('120.50');
await page.screenshot({ path: `${out}/2-topup-form.png` });
await page.getByRole('button', { name: '确认充值' }).click();
await page.waitForTimeout(2500);
await balanceCard.screenshot({ path: `${out}/3-after-topup.png` });
const balanceText = await balanceCard.innerText();
console.log('2. after top-up, card says:', balanceText.split('\n').slice(0, 3).join(' | '));

// --- Withdraw ---------------------------------------------------------------
await page.getByRole('button', { name: '取现' }).first().click();
await page.waitForTimeout(300);
await page.getByLabel('金额').fill('20.50');
await page.getByLabel('提现至').fill('尾号 4242 的银行卡');
await page.getByRole('button', { name: '申请提现' }).click();
await page.waitForTimeout(2500);
await balanceCard.screenshot({ path: `${out}/4-after-withdraw.png` });
console.log('3. after withdrawal:', (await balanceCard.innerText()).split('\n').slice(0, 3).join(' | '));

// --- Overdraft must be refused in the UI too --------------------------------
await page.getByRole('button', { name: '取现' }).first().click();
await page.waitForTimeout(300);
await page.getByLabel('金额').fill('9999');
await page.getByLabel('提现至').fill('尾款卡');
await page.getByRole('button', { name: '申请提现' }).click();
await page.waitForTimeout(2000);
const errorVisible = await page.locator('.form-error').first().isVisible().catch(() => false);
console.log('4. overdraft shows an inline error:', errorVisible);
await balanceCard.screenshot({ path: `${out}/5-overdraft-refused.png` });

// --- English rendering ------------------------------------------------------
await page.context().addCookies([{ name: 'easytrip_lang', value: 'en', url: base }]);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('section', { hasText: 'Balance' }).first().screenshot({ path: `${out}/6-english.png` });
const englishText = await page.locator('section', { hasText: 'Balance' }).first().innerText();
console.log('5. english card:', englishText.split('\n').slice(0, 8).join(' | '));

await browser.close();
console.log(`\n→ ${out}`);
