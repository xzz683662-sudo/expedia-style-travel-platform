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

  /**
   * Real-time supply layer.
   *
   * Off by default, and that is a correctness requirement rather than caution:
   * every consumer of these values falls back to `TicketType.basePriceCents`
   * when the layer is disabled, so the platform's existing behaviour is
   * bit-for-bit unchanged until an operator opts in.
   *
   * TTLs are deliberately ordered by how much a stale answer costs. Search may
   * be minutes old (a shopper is still browsing). Availability should not be.
   * Checkout ignores all of them — see `modules/supply/live.ts`.
   */
  supply: {
    live: {
      enabled: str('SUPPLY_LIVE_ENABLED', 'false') === 'true',
      searchTtlSeconds: int('SUPPLY_LIVE_SEARCH_TTL', 300),
      detailTtlSeconds: int('SUPPLY_LIVE_DETAIL_TTL', 60),
      availabilityTtlSeconds: int('SUPPLY_LIVE_AVAILABILITY_TTL', 30),
      /**
       * Hosts whose images may be written to `ProductMedia.url`.
       *
       * An allow-list rather than a proxy: `next.config.ts` needs a matching
       * `remotePatterns` entry either way, and a generic `?url=` image proxy
       * would be an SSRF hole for no gain.
       */
      allowedImageHosts: str('SUPPLY_LIVE_IMAGE_HOSTS', '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    },

    /**
     * Per-provider credentials.
     *
     * An adapter is wired into {@link liveRateSources} unconditionally, but it
     * only answers when its credential is present: `getRates` returns `[]`
     * otherwise, which the resolver reads as "this source carries no data"
     * rather than as an error. That keeps the chain free of `if (enabled)`
     * branches at the call site and means a deployment with no commercial
     * credentials behaves exactly as it did before any adapter existed.
     *
     * Every value here was verified against the live upstream on 2026-10-05;
     * see `docs/supply-sources.md` for the per-provider evidence.
     */
    kiwi: {
      /** Tequila API key. Partner registration is by email magic link. */
      apiKey: str('KIWI_API_KEY'),
      baseUrl: str('KIWI_BASE_URL', 'https://tequila-api.kiwi.com'),
    },
    serpapi: {
      apiKey: str('SERPAPI_API_KEY'),
      baseUrl: str('SERPAPI_BASE_URL', 'https://serpapi.com'),
    },
    /**
     * trvl — a zero-key Go binary that returns real flight and hotel prices.
     *
     * Off unless explicitly enabled, because trvl is a personal-use tool that
     * reads Google Flights and Google Hotels, and its own README puts the terms
     * of service question on the operator. That is a business decision, so it
     * must be made out loud rather than by default.
     *
     * Wired as a *pre-warm* source, never inline: one invocation measured 24.6 s,
     * which would be fatal inside a request. A background loop calls
     * `warmTrvlRoute` and {@link TrvlRateSource} reads the result from Redis.
     */
    trvl: {
      enabled: str('TRVL_ENABLED', 'false') === 'true',
      /** Absolute path to the `trvl` binary. Empty means the source is inert. */
      binaryPath: str('TRVL_BINARY_PATH'),
      /** How long a warmed price stays usable. Search freshness is minutes; this matches. */
      warmTtlSeconds: int('TRVL_WARM_TTL', 900),
      /** Spawn budget. Generous because a call measured ~25 s. */
      timeoutMs: int('TRVL_TIMEOUT_MS', 90_000),
    },
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