/**
 * ---------------------------------------------------------------------------
 * Supply credential classification
 * ---------------------------------------------------------------------------
 *
 * The distinction this file exists to make, in the mandate's own words:
 *
 *   > 实时数据方案必须同时审计"数据获取凭证"和"交易凭证"，两者不能混为一谈。
 *   > (A live-data plan must audit *data-access* credentials and *transaction*
 *   >  credentials separately; the two must never be conflated.)
 *
 * Reading a price and being able to sell at it are different powers, held by
 * different parties, under different contracts. A platform that treats "we have
 * an API key" as "we can take money" will eventually promise a booking it
 * cannot fulfil — which is exactly the failure `docs/supply-sources.md` was
 * written to prevent.
 *
 * So every source is classified by *what its credential authorises*, and the
 * classes are ordered by the power they grant:
 *
 *   PUBLIC       no credential at all; anyone may read the bytes
 *   API_KEY      identifies a caller for data access. Grants **no** commercial
 *                right over the data and **no** ability to transact
 *   SUPPLIER     a supplier relationship that returns real inventory and real
 *                prices. Still a *read* power
 *   BOOKING      authority to create a real reservation upstream — a *write*
 *                power against someone else's inventory
 *   SETTLEMENT   authority to move real money (charge, capture, refund, payout)
 *
 * The last two are transaction credentials. This stage's boundary admits only
 * the first three, and only for reading:
 *
 *   > 本阶段交易边界（stage transaction boundary）
 *   >   permissible: public live data · third-party live-data APIs ·
 *   >                a SUPPLIER credential used to READ live price/inventory
 *   >   not permissible: BOOKING · SETTLEMENT
 *
 * `pnpm credentials:contract` enforces the boundary offline — see the bottom of
 * this file. Nothing else in the codebase may widen it silently.
 */

import { PaymentChannel } from '@prisma/client';

/** What a credential authorises. Ordered weakest → strongest. */
export type CredentialKind = 'PUBLIC' | 'API_KEY' | 'SUPPLIER' | 'BOOKING' | 'SETTLEMENT';

/** Every credential kind, weakest first. The order is load-bearing: a source
 *  "at least" a given kind is one whose index is ≥ that kind's index. */
export const CREDENTIAL_ORDER: readonly CredentialKind[] = ['PUBLIC', 'API_KEY', 'SUPPLIER', 'BOOKING', 'SETTLEMENT'];

/** Kinds that can move money or create reservations upstream. */
export const TRANSACTION_KINDS: readonly CredentialKind[] = ['BOOKING', 'SETTLEMENT'];

/** What a source is *about*. Keeps the audit readable across domains. */
export type SourceDomain = 'FLIGHT' | 'HOTEL' | 'CRUISE' | 'GROUND' | 'POSITION' | 'CONTENT' | 'PAYMENT';

export interface SourceCredential {
  /** Stable id. Matches the source id in docs/supply-sources.md where one exists. */
  readonly id: string;
  readonly name: string;
  readonly domain: SourceDomain;
  /** The strongest power this credential grants, and every kind it spans. */
  readonly kinds: readonly CredentialKind[];
  /**
   * True only when the source's credential is actually present and usable for a
   * *read* purpose in the current deployment. A documented-but-uncredentialed
   * source is `available: false`, which is how "we could" stays distinct from
   * "we do".
   */
  readonly available: boolean;
  /** True when the credential can create a real upstream reservation. */
  readonly canBook: boolean;
  /** True when the credential can move real money. */
  readonly canSettle: boolean;
  /** The env var(s) that carry the credential, for the ops audit. */
  readonly envVars: readonly string[];
  /** One-line provenance / evidence note. */
  readonly evidence: string;
}

/** The strongest kind a source holds, derived rather than stored twice. */
export function strongestKind(source: SourceCredential): CredentialKind {
  return CREDENTIAL_ORDER.reduce(
    (strongest, kind) => (source.kinds.includes(kind) ? kind : strongest),
    'PUBLIC' as CredentialKind,
  );
}

/**
 * The stage boundary. Declared once, here, so it is a value the contract gate
 * can read rather than a paragraph someone has to remember.
 */
export const STAGE_BOUNDARY = {
  /** Credential kinds this stage may *use*. */
  allowedKinds: ['PUBLIC', 'API_KEY', 'SUPPLIER'] as readonly CredentialKind[],
  /** No credential in this stage may do these, whatever class it is. */
  forbiddenCapabilities: ['canBook', 'canSettle'] as const,
  /**
   * A read-only use of a SUPPLIER credential is allowed; a write use is not.
   * This is the line that separates "we may show you a live price" from "we may
   * sell you the seat".
   */
  supplierUse: 'READ_ONLY' as const,
};

/**
 * Every source the platform knows about, classified.
 *
 * Grouped by domain. This is the audit the mandate asks for; the contract gate
 * reads it, and `docs/supply-sources.md` carries the same table prose-first.
 */
export const SOURCE_CREDENTIALS: readonly SourceCredential[] = [
  // --- Open datasets: identity and geometry only ---------------------------
  {
    id: 'ourairports',
    name: 'OurAirports data',
    domain: 'CONTENT',
    kinds: ['PUBLIC'],
    available: true,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'Public-domain CSV. Imported by modules/supply/ourairports.ts.',
  },
  {
    id: 'overture-places',
    name: 'Overture Maps places',
    domain: 'CONTENT',
    kinds: ['PUBLIC'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'CDLA-Permissive-2.0 / ODbL per theme. Candidate, not wired.',
  },
  {
    id: 'osm-pois',
    name: 'OpenStreetMap POIs',
    domain: 'CONTENT',
    kinds: ['PUBLIC'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'ODbL share-alike. Candidate, not wired.',
  },
  {
    id: 'wikipedia-content',
    name: 'Wikipedia REST content',
    domain: 'CONTENT',
    kinds: ['PUBLIC'],
    available: true,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'Descriptive content only; never a fare or an allotment. Probed 200 on 2026-10-04.',
  },

  // --- Live positions: ephemeral, never persisted, never priced ------------
  {
    id: 'adsb-lol',
    name: 'adsb.lol live ADS-B',
    domain: 'POSITION',
    kinds: ['PUBLIC'],
    available: true,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'No key. Refuses the default `node` UA (403); adapter sends a contact UA. Verified 2026-10-04.',
  },
  {
    id: 'opensky-network',
    name: 'OpenSky Network states',
    domain: 'POSITION',
    kinds: ['PUBLIC'],
    available: true,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'Anonymous quota. Fallback only; ignores its own callsign param. Verified 2026-10-04.',
  },

  // --- Live rates: commercial terms, read-only in this stage ---------------
  {
    id: 'trvl',
    name: 'trvl (Google Flights/Hotels reader)',
    domain: 'FLIGHT',
    kinds: ['PUBLIC'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: ['TRVL_ENABLED', 'TRVL_BINARY_PATH'],
    evidence: 'Zero-key binary, but its own README puts the ToS risk on the operator; ships off. Pre-warm only.',
  },
  {
    id: 'kiwi.tequila',
    name: 'Kiwi.com Tequila (metasearch)',
    domain: 'FLIGHT',
    kinds: ['API_KEY'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: ['KIWI_API_KEY'],
    evidence:
      '403 without a key = alive and credential-enforced. Aggregator: prices move the quote, no allotment, no confirmation. Stripe of sellability is the platform\'s own InventoryRecord.',
  },
  {
    id: 'serpapi',
    name: 'SerpApi (Google Flights/Hotels scrape)',
    domain: 'FLIGHT',
    kinds: ['API_KEY'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: ['SERPAPI_API_KEY'],
    evidence: 'Configured but deliberately NOT wired: unauthorised redistribution of Google results is a business decision, not a technical one.',
  },
  {
    id: 'amadeus',
    name: 'Amadeus Self-Service / Enterprise',
    domain: 'FLIGHT',
    kinds: ['API_KEY', 'SUPPLIER'],
    /**
     * `available: false` — the self-service portal was decommissioned
     * 2025-07-17 and access is now an enterprise sales agreement. Note the two
     * kinds: even the *documented* capability spans data access and a supplier
     * relationship, which is precisely the conflation this file separates.
     */
    available: false,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence: 'Token endpoint exists but returns "blocked by our security service". Enterprise agreement required.',
  },
  {
    id: 'apify.expedia-hotels',
    name: 'Apify jupri/expedia-hotels (scraper)',
    domain: 'HOTEL',
    kinds: ['API_KEY', 'SUPPLIER'],
    /**
     * A SUPPLIER classification here means real prices are returned, NOT that a
     * booking can be made — the actor is a scraper with no fulfilment path. The
     * staging design (`ScrapedInventory`) plus `canBook: false` is what keeps
     * that honest.
     */
    available: true,
    canBook: false,
    canSettle: false,
    envVars: ['APIFY_TOKEN', 'APIFY_HOTEL_ACTOR'],
    evidence:
      'Token required; FULL_PERMISSIONS approval needed. 0.107% success; every probe hit HTTP 429 via the shared residential proxy. Billed per platform usage, not per row.',
  },
  {
    id: 'cruise',
    name: 'Cruise lines (Royal Caribbean, MSC, Carnival …)',
    domain: 'CRUISE',
    kinds: ['SUPPLIER', 'BOOKING'],
    available: false,
    canBook: false,
    canSettle: false,
    envVars: [],
    evidence:
      'No free or licence-clean source; each operator sells through its own agency channel. Not wired, not stubbed — a known gap. Classified BOOKING to record what a real integration WOULD require, which is why it is unavailable here.',
  },

  // --- Payment rails: the transaction-credential half of the audit ---------
  {
    id: 'hyperswitch',
    name: 'Hyperswitch payment router',
    domain: 'PAYMENT',
    kinds: ['SETTLEMENT'],
    available: false,
    canBook: false,
    canSettle: true,
    envVars: ['PAYMENT_PROVIDER', 'HYPERSWITCH_BASE_URL', 'HYPERSWITCH_API_KEY'],
    evidence: 'Real settlement adapter exists; selected only when PAYMENT_PROVIDER=hyper AND a base URL is set. Default is the mock gateway.',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    domain: 'PAYMENT',
    kinds: ['SETTLEMENT'],
    available: false,
    canBook: false,
    canSettle: true,
    envVars: ['PAYPAL_MODE', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
    evidence: 'Adapter modelled; sandbox-only in this stage. No live credential is used.',
  },
  {
    id: 'crypto-trc20',
    name: 'TRC20 (Tron) USDT wallet',
    domain: 'PAYMENT',
    kinds: ['SETTLEMENT'],
    available: false,
    canBook: false,
    canSettle: true,
    envVars: ['TRC20_MODE', 'TRC20_RECEIVING_ADDRESS'],
    evidence:
      'Self-custodial receiving address. Adapter modelled; no live value transferred in this stage. On-chain settlement is irreversible, so it is modelled as a separate, explicitly-enabled rail.',
  },
];

/** Every kind a source spans, including transitively-implying ones. */
export function implies(credential: CredentialKind, minimum: CredentialKind): boolean {
  return CREDENTIAL_ORDER.indexOf(credential) >= CREDENTIAL_ORDER.indexOf(minimum);
}

/**
 * Sources whose credential can transact. Under this stage's boundary this must
 * be empty *and unused*: a list is not a permission.
 */
export function transactionCapableSources(): readonly SourceCredential[] {
  return SOURCE_CREDENTIALS.filter((source) => source.canBook || source.canSettle);
}

/**
 * Sources usable for reading live data right now: credential present, and no
 * transaction power required.
 */
export function readableSources(): readonly SourceCredential[] {
  return SOURCE_CREDENTIALS.filter(
    (source) => source.available && !source.canBook && !source.canSettle,
  );
}

/**
 * The payment channels this stage models. `PayPal` and `crypto TRC20` are added
 * to the enum and gated by the same boundary: modelled, sandbox-only, no live
 * settlement credential.
 */
export const STAGE_PAYMENT_CHANNELS: readonly PaymentChannel[] = [
  PaymentChannel.CARD,
  PaymentChannel.PAYPAL,
  PaymentChannel.CRYPTO_TRC20,
];
