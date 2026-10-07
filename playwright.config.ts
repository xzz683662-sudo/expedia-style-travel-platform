import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-audit / end-to-end harness.
 *
 * Separate from `pnpm verify` on purpose. `verify` must stay deterministic and
 * offline; this suite drives a real browser against a running API and web
 * server, and the reference site it audits lives on the public internet. It is
 * therefore a *manual* gate (and a CI job of its own), not part of the default
 * chain.
 *
 * Servers must already be running:
 *   API  → http://localhost:4000   (`pnpm dev:api`)
 *   web  → http://localhost:3000   (`pnpm --filter @easytrip/web build` then `next start`)
 *
 * Deliberately no `webServer` block: the web app needs the API, so auto-starting
 * one without the other produces an audit of error pages that looks green.
 */
export default defineConfig({
  testDir: './scripts/ux-audit',
  outputDir: './artifacts/ux-audit/_output',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // The audit writes screenshots into shared paths, and the reference site
  // should not be hammered from several workers at once.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A locale the storefront actually ships. Without this the audit would
    // exercise the `en-US` fallback and miss every Chinese string.
    locale: 'en-US',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
