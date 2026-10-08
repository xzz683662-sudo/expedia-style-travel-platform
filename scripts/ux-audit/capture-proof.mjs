import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

/**
 * Visual proof capture.
 *
 * Takes screenshots of the *running* app showing each newly added surface, so a
 * reviewer can see the change without reading a diff. Run with the API and web
 * servers already up.
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const api = 'http://localhost:4000/api/v1';
const password = 'Password123' + String.fromCharCode(33);
const out = 'artifacts/proof';
mkdirSync(out, { recursive: true });

async function post(path, body, token) {
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// --- 1. Storefront with the embedded support bubble --------------------------
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.screenshot({ path: `${out}/1-home-with-chat-bubble.png` });
console.log('1 home: bubble visible =', await page.locator('[data-testid="support-bubble"]').isVisible());

// --- 2. Register, then the verification step ---------------------------------
const email = `proof.${Date.now()}@easytrip.test`;
await page.goto(`${base}/register`, { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="register-form"]').getByLabel(/first name/i).fill('Proof');
await page.locator('[data-testid="register-form"]').getByLabel(/last name/i).fill('Shot');
await page.locator('[data-testid="register-form"]').getByLabel(/email/i).fill(email);
await page.locator('[data-testid="register-form"]').getByLabel(/password/i).fill(password);
await page.locator('[data-testid="register-form"]').getByRole('button', { name: /create account/i }).click();

await page.locator('[data-testid="verify-form"]').waitFor();
await page.screenshot({ path: `${out}/2-verify-step.png` });
const codeText = await page.locator('[data-testid="dev-code"]').innerText();
const code = codeText.match(/\d{6}/)?.[0];
console.log('2 verification step: dev code visible =', code);

// --- 3. Unverified shopper sees the header banner ----------------------------
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.screenshot({ path: `${out}/3-unverified-banner.png` });
console.log('3 unverified banner visible =', await page.locator('[data-testid="verify-banner"]').isVisible());

// --- 4. Complete verification from the standalone page -----------------------
await page.goto(`${base}/verify-email`, { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="verify-page-code"]').fill(code);
await page.locator('[data-testid="verify-page-submit"]').click();
await page.waitForTimeout(2500);
await page.goto(base, { waitUntil: "domcontentloaded" });
console.log('4 banner after verifying =', await page.locator('[data-testid="verify-banner"]').isVisible());
await page.screenshot({ path: `${out}/4-after-verified.png` });

// --- 5. Open the chat panel and send a message ------------------------------
await page.locator('[data-testid="support-bubble"]').click();
await page.locator('[data-testid="support-panel"]').waitFor();
await page.locator('[data-testid="support-input"]').fill('我的订单需要改期，可以帮忙吗？');
await page.locator('[data-testid="support-send"]').click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/5-chat-open.png` });
console.log('5 chat thread: message rendered =', await page.locator('[data-testid="support-messages"]').innerText().then((t2) => t2.includes('改期')));

// --- 6. The agent side: the support inbox -----------------------------------
const login = await post('/auth/login', { email: 'support@easytrip.test', password });
await page.evaluate(([t, u]) => {
  localStorage.setItem('easytrip.token', t);
  localStorage.setItem('easytrip.user', JSON.stringify({ id: 'x', email: u, firstName: 'Casey', lastName: 'Support' }));
}, [login.token, 'support@easytrip.test']);

await page.goto(`${base}/support/inbox`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.locator('[data-testid="inbox-item"]').first().click().catch(() => undefined);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/6-support-inbox.png` });
console.log('6 inbox: rows =', await page.locator('[data-testid="inbox-item"]').count());

await browser.close();
console.log('\nscreenshots →', out);
