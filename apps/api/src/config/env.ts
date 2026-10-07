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
       * Maximum tolerated gap between a live net rate and the catalogue's own
       * `TicketType.basePriceCents` at checkout, in basis points.
       *
       * `0` (the default) disables the guard, and that is a correctness choice
       * rather than caution: a live rate is *expected* to differ from the seeded
       * catalogue figure, so enforcing equality would reject every order the
       * moment a live source is switched on. Set a non-zero value when the
       * catalogue price is meant to act as a ceiling and a larger move should
       * send the shopper back to re-select rather than silently charge a
       * different number.
       */
      checkoutToleranceBps: int('SUPPLY_LIVE_CHECKOUT_TOLERANCE_BPS', 0),
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

  /**
   * Inventory feed — third-party hotel rows, staged and never sold.
   *
   * A distinct subsystem from `supply.live` above: that layer moves the price a
   * shopper is quoted; this one stages scraped *candidates* for an operator to
   * promote by hand into first-party products (positioning option A). It writes
   * only `ScrapedInventory` and never any table the booking path reads.
   *
   * Off by default, and that is a safety requirement rather than caution: with
   * `INVENTORY_FEED_ENABLED=false` the `/admin/inventory-feed` routes 404 and no
   * scheduler starts, so the platform is bit-for-bit unchanged.
   */
  inventoryFeed: {
    enabled: str('INVENTORY_FEED_ENABLED', 'false') === 'true',
    /** Apify API token. Never logged, never returned by a route. */
    apifyToken: str('APIFY_TOKEN'),
    /** Actor slug, `owner/name`. Overridable so the feed can be repointed. */
    apifyActor: str('APIFY_HOTEL_ACTOR', 'jupri/expedia-hotels'),
    /**
     * Portal id selecting the actor's **region and currency** (its `site`
     * input). `"1"` is Expedia US, which answers in **USD** — the platform's
     * settlement currency, so no conversion is needed for the staged figure.
     *
     * The actor validates this as a numeric id, not a hostname: sending
     * `"expedia.com"` fails with `Field input.site must be equal to one of the
     * allowed values`. See docs/supply-sources.md for the probed evidence.
     */
    site: str('APIFY_HOTEL_SITE', '1'),
    /** Locale the actor answers in, e.g. `en_US`. */
    language: str('APIFY_HOTEL_LANGUAGE', 'en_US'),
    /**
     * Which `includes:*` blocks to request, comma-separated: `offers`,
     * `location`, `amenities`, `review`, `calendar`, `availability`, ...
     *
     * Empty by default because every block is extra upstream traffic, and the
     * actor's reliability is the constraint (measured 0.107%). Enable only the
     * blocks a promotion actually needs — `offers` carries room prices,
     * `location` carries the coordinates the catalogue stores.
     */
    includes: str('APIFY_HOTEL_INCLUDES', '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    /**
     * Operator-supplied proxy for the actor's `dev_proxy_config`, as a JSON
     * object string. Empty means "use the actor's default (Apify residential)". 
     *
     * This exists because the default is the problem: every probed run failed
     * with `HTTP 429 Too Many Requests` coming through
     * `<http://groups-RESIDENTIAL@…> (REQUIRED)` — Apify's *shared* residential
     * proxy group, which Expedia rate-limits across all 677 actor users. The
     * actor documents `dev_proxy_config` (HTTP(S) or SOCKS5) as the way to
     * supply your own egress.
     *
     * Supplied as raw JSON rather than a URL so this code does not *guess* the
     * object's field names — the actor's schema is undocumented beyond the URL
     * format, so the exact shape stays the operator's to provide:
     *
     *   APIFY_HOTEL_PROXY_CONFIG='{"useApifyProxy":false,"proxyUrls":["socks5://host:9000"]}'
     */
    proxyConfig: str('APIFY_HOTEL_PROXY_CONFIG'),
    /**
     * Refuse to start a batch that would exceed this many rows. A run is billed
     * per platform usage, so an accidental unbounded `limit` is a bill, not just
     * a slow job.
     */
    maxRowsPerRun: int('INVENTORY_FEED_MAX_ROWS', 500),
    /** How long to wait for an Apify run before giving up on it. */
    runTimeoutMs: int('INVENTORY_FEED_RUN_TIMEOUT_MS', 900_000),
    pollIntervalMs: int('INVENTORY_FEED_POLL_MS', 5_000),
    /** A row not confirmed by a successful sync within this window is STALE. */
    staleAfterHours: int('INVENTORY_FEED_STALE_HOURS', 48),
  },

  /**
   * FX — turning an upstream rate into the currency the platform sells in.
   *
   * Needed because upstreams choose their own currency (trvl is EUR-only,
   * measured) while `TicketType.currency` is whatever the seller set — eight
   * currencies are in the catalogue. Without this, `pickOffer` discards any
   * offer that does not already match, which removes live pricing from most of
   * the catalogue.
   *
   * Deliberately *not* a rewrite of stored prices: `TicketType.basePriceCents`
   * is what a previous order was priced against, and settlement still happens in
   * `TicketType.currency`. See `utils/fx.ts` for the full reasoning.
   */
  fx: {
    /** Free, key-less JSON endpoint. Overridable so it can be swapped or stubbed. */
    baseUrl: str('FX_BASE_URL', 'https://open.er-api.com/v6/latest'),
    timeoutMs: int('FX_TIMEOUT_MS', 8_000),
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

    /**
     * PayPal — a modelled settlement rail.
     *
     * `mode` defaults to `sandbox` and MUST stay there for this stage: the
     * credential boundary (modules/supply/credentials.ts) admits no live
     * settlement credential yet. `live` is refused at the adapter, not merely
     * unconfigured, so a stray env var cannot move real money.
     */
    paypal: {
      mode: str('PAYPAL_MODE', 'sandbox'),
      clientId: str('PAYPAL_CLIENT_ID'),
      clientSecret: str('PAYPAL_CLIENT_SECRET'),
      baseUrl: str('PAYPAL_BASE_URL', 'https://api-m.sandbox.paypal.com'),
    },

    /**
     * TRC20 (Tron) USDT — a modelled self-custodial settlement rail.
     *
     * Same boundary as PayPal, with one extra reason to be careful: on-chain
     * settlement is irreversible. It is therefore a separate, explicitly-enabled
     * rail rather than a card variant, and it ships sandbox-only.
     */
    crypto: {
      mode: str('TRC20_MODE', 'sandbox'),
      receivingAddress: str('TRC20_RECEIVING_ADDRESS'),
      network: str('TRC20_NETWORK', 'tron'),
      /** Confirmations before a transfer is treated as settled. */
      confirmations: int('TRC20_CONFIRMATIONS', 19),
    },
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

  /**
   * Global per-IP request ceiling.
   *
   * Configurable because the default is tuned for a human shopper, and a
   * browser-driven test is not one: a single page load fires a dozen API calls
   * plus Next's prefetches, so an automated pass over the storefront exhausts a
   * 300/min budget in seconds and then watches unrelated requests fail with 429
   * — which looks like a product bug and is not.
   */
  rateLimit: {
    max: int('RATE_LIMIT_MAX', 300),
    windowSeconds: int('RATE_LIMIT_WINDOW_SECONDS', 60),
  },

  /**
   * Outbound email — currently only the address-verification code.
   *
   * Zero-key by default. `console` writes the message to the API log, which is
   * enough for local development and for the end-to-end test to read the code
   * back without a mailbox. Production switches `MAIL_TRANSPORT=resend` and
   * supplies `RESEND_API_KEY`.
   *
   * SMTP is intentionally *not* built in: it needs a dependency, and this
   * repository ships no mail library. Adding one for a path nothing uses yet
   * would be cargo culting; the transport interface is the extension point.
   */
  mail: {
    transport: str('MAIL_TRANSPORT', 'console'),
    fromAddress: str('MAIL_FROM', 'EasyTrip <no-reply@easytrip.test>'),
    resendApiKey: str('RESEND_API_KEY'),
    resendBaseUrl: str('RESEND_BASE_URL', 'https://api.resend.com'),
    /** How long a verification code stays valid. */
    codeTtlMinutes: int('MAIL_CODE_TTL_MINUTES', 15),
    /** Wrong guesses allowed before a code is dead. Caps brute-force online. */
    maxAttempts: int('MAIL_CODE_MAX_ATTEMPTS', 5),
    /** Minimum gap between resend requests for one account. */
    resendCooldownSeconds: int('MAIL_RESEND_COOLDOWN_SECONDS', 45),
    /**
     * Return the code in the API response so an automated test can complete the
     * flow without reading a mailbox. Forced off in production regardless of
     * the transport, so this can never leak a code from a real deployment.
     */
    exposeDevCode:
      str('MAIL_TRANSPORT', 'console') === 'console' && str('NODE_ENV', 'development') !== 'production',
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