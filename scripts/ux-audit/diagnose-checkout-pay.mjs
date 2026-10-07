import { chromium } from 'playwright';

/**
 * Focused reproduction: drive the checkout UI and log every request/response to
 * the API so a stuck payment says *why* instead of just hanging.
 */
const base = process.env.WEB_URL ?? 'http://localhost:3000';
const api = 'http://localhost:4000/api/v1';
const password = 'Password123' + String.fromCharCode(33);

const email = `repro.${Date.now()}@easytrip.test`;

// Register + verify over HTTP, so the browser starts from a signed-in state.
const reg = await fetch(`${api}/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, firstName: 'Re', lastName: 'Pro' }),
}).then((r) => r.json());
await fetch(`${api}/auth/verify-email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, code: reg.emailVerification.devCode }),
});
console.log('registered + verified:', email);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`  [console.${m.type()}]`, m.text().slice(0, 220));
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
page.on('requestfailed', (r) => console.log('  [requestfailed]', r.method(), r.url().slice(0, 140), r.failure()?.errorText));
page.on('response', async (r) => {
  const url = r.url();
  if (!url.includes('/api/v1/') && !url.includes('/media/')) return;
  if (r.request().method() === 'GET' && r.status() === 200) return;
  console.log(`  [net] ${r.request().method()} ${url.slice(0, 130)} → ${r.status()}`);
  if (url.includes('/pay')) {
    console.log('  [pay body]', (await r.text().catch((e) => `<unreadable: ${e.message}>`)).slice(0, 400));
  }
});

await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
await page.evaluate(([t, u]) => {
  localStorage.setItem('easytrip.token', t);
  localStorage.setItem('easytrip.user', JSON.stringify({ id: 'x', email: u, firstName: 'Re', lastName: 'Pro' }));
}, [reg.token, email]);

const href = await page.locator('a[href^="/products/"]').first().getAttribute('href');
await page.goto(`${base}${href}`, { waitUntil: 'networkidle' });
console.log('product:', href);

await page.getByRole('button', { name: /reserve & continue/i }).first().click();
await page.waitForURL(/\/checkout/);
console.log('checkout url:', page.url());

await page.getByRole('button', { name: /continue to details/i }).click();
const emailField = page.getByLabel(/email address/i).first();
if (!(await emailField.inputValue())) await emailField.fill(email);
const nameField = page.getByLabel(/lead guest name/i).first();
if (!(await nameField.inputValue())) await nameField.fill('Re Pro');
await page.getByRole('button', { name: /reserve & continue/i }).click();

await page.getByLabel(/card number/i).first().waitFor({ timeout: 30_000 });
console.log('payment step reached');

// List the visible inputs so we know exactly what the form expects.
const inputs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('input')).map((i) => ({
    name: i.getAttribute('name') ?? '',
    type: i.type,
    id: i.id,
    required: i.required,
    placeholder: i.placeholder,
    value: i.value,
  })),
);
console.log('inputs:', JSON.stringify(inputs, null, 1));

await page.getByLabel(/card number/i).first().fill('4242424242424242');
const cvc = page.getByLabel(/cvc/i).first();
if (await cvc.count()) await cvc.fill('123');

const payButton = page.getByRole('button', { name: /pay/i }).first();
console.log('pay button text:', (await payButton.innerText()).trim(), 'disabled=', await payButton.isDisabled());

await payButton.click();
await page.waitForTimeout(12_000);
console.log('url after pay:', page.url());
console.log('pay button text now:', (await page.getByRole('button', { name: /pay|processing/i }).first().innerText().catch(() => '<none>')).trim());
console.log('checkout body:', (await page.locator('main').innerText()).slice(0, 700).replace(/\n/g, ' | '));

await browser.close();
