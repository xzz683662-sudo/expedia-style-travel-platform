import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * Locate the monorepo root .env by walking up from `start`.
 *
 * We deliberately do not hard-code `../../../../.env`: under `tsx` the value of
 * `__dirname` tracks the process working directory rather than the source
 * layout, and under `node dist` it does the opposite. A hard-coded depth
 * therefore works for exactly one of the two run modes.
 *
 * Getting this wrong is silent — dotenv does not throw on a missing file. It
 * just leaves DATABASE_URL unset, and the mistake only surfaces much later as a
 * confusing Prisma "environment variable not found" validation error.
 */
function findEnvFile(start: string): string | undefined {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return undefined;
}

// Root .env first, then a per-app override if one exists.
const rootEnv = findEnvFile(__dirname) ?? findEnvFile(process.cwd());
if (rootEnv) loadEnv({ path: rootEnv });
loadEnv({ path: resolve(process.cwd(), '.env') });

function str(key: string, fallback = ''): string {
  const value = process.env[key];
  return value === undefined ? fallback : value;
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(str(key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function num(key: string, fallback: number): number {
  const parsed = Number.parseFloat(str(key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', int('API_PORT', 4000)),
  host: str('API_HOST', '0.0.0.0'),
  publicUrl: str('API_PUBLIC_URL', `http://localhost:${int('API_PORT', 4000)}`),

  databaseUrl: str('DATABASE_URL'),

  redisUrl: str('REDIS_URL'),

  search: {
    node: str('OPENSEARCH_NODE'),
    username: str('OPENSEARCH_USERNAME'),
    password: str('OPENSEARCH_PASSWORD'),
    index: str('OPENSEARCH_INDEX', 'easytrip-products'),
    enabled: Boolean(str('OPENSEARCH_NODE')),
  },

  storage: {
    endpoint: str('S3_ENDPOINT'),
    region: str('S3_REGION', 'us-east-1'),
    bucket: str('S3_BUCKET', 'easytrip-tickets'),
    accessKeyId: str('S3_ACCESS_KEY_ID'),
    secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: str('S3_FORCE_PATH_STYLE', 'true') === 'true',
    // When no object store is configured we write artefacts to disk so the
    // ticket/PDF flow stays fully testable in local development.
    localDir: str('LOCAL_STORAGE_DIR', resolve(__dirname, '../../storage')),
  },

  /**
   * Where the flight catalogue's schedule and fare data comes from.
   *
   * This is a correctness switch, not a feature flag. Flight schedules, fares
   * and seat inventory are regulated commercial assets that airlines distribute
   * through GDS/NDC partners; without such a contract they cannot be obtained
   * from open data at all. Everything in `apps/api/prisma/seed-*.ts` is
   * therefore **synthetic** — written by this repo, not by any airline.
   *
   * `FLIGHT_DATA_ORIGIN=SEED` makes the API say so on every flight payload, and
   * the storefront renders a notice from it. Selling that data to a customer as
   * a real ticket is not a display bug; it is selling something that does not
   * exist, so the default is to disclose and the only way to stop disclosing is
   * to configure a real feed.
   */
  flights: {
    /** `SEED` (default) | `GDS` | `NDC` — see docs/supply-sources.md. */
    origin: str('FLIGHT_DATA_ORIGIN', 'SEED'),
    /**
     * Show the synthetic-data notice to customers. Defaults on whenever the
     * origin is `SEED`, so it cannot be forgotten; set `FLIGHT_DISCLOSE=false`
     * only alongside a real feed.
     */
    disclose: str('FLIGHT_DISCLOSE', str('FLIGHT_DATA_ORIGIN', 'SEED') === 'SEED' ? 'true' : 'false') === 'true',
  },

  payments: {
    provider: str('PAYMENT_PROVIDER', 'mock'),
    baseUrl: str('HYPERSWITCH_BASE_URL'),
    apiKey: str('HYPERSWITCH_API_KEY'),
    webhookSecret: str('PAYMENT_WEBHOOK_SECRET', 'whsec_dev_change_me'),
    /** Cards ending in these digits force a decline in the mock gateway. */
    declineSuffix: str('MOCK_DECLINE_SUFFIX', '0002'),
    /** Cards ending with these digits force an authorisation failure. */
    failureSuffix: str('MOCK_FAILURE_SUFFIX', '0119'),
  },

  booking: {
    holdMinutes: int('INVENTORY_HOLD_MINUTES', 15),
    defaultCurrency: str('CURRENCY_DEFAULT', 'USD'),
    markupBps: int('MARKUP_BPS', 1200),
    platformFeeBps: int('PLATFORM_FEE_BPS', 1200),
    taxBps: int('TAX_BPS', 800),
    checkoutTokenTtlMinutes: int('CHECKOUT_TOKEN_TTL_MINUTES', 20),
    maxQtyPerOrder: int('MAX_QTY_PER_ORDER', 10),
  },

  auth: {
    secret: str('JWT_SECRET', 'dev_jwt_secret_change_me'),
    expiresIn: str('JWT_EXPIRES_IN', '7d'),
  },

  site: {
    url: str('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000'),
    // Simplified Chinese first because the storefront ships an en/zh switcher;
    // the European locales are here for pricing and tax formatting.
    supportedLocales: ['zh-CN', 'en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'it-IT'],
    defaultLocale: 'en-US',
    defaultMarket: str('DEFAULT_MARKET', 'US'),
  },
} as const;

export type AppConfig = typeof config;