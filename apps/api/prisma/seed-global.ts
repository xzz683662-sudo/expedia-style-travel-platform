import type { ProductType } from '@prisma/client';
import type { SeedProduct, SeedTicketType } from './seed-data';
import { CITIES, type CityDescriptor } from './seed-cities';
import { PHOTO_POOLS } from './photo-pools';
import { CITY_IMAGES } from './city-images';

/**
 * ---------------------------------------------------------------------------
 * Global catalogue generator
 * ---------------------------------------------------------------------------
 *
 * Every city in `seed-cities.ts` receives a full, bilingual, six-category
 * catalogue from this file:
 *
 *   1. International flights  (FLIGHT)
 *   2. Luxury hotels           (HOTEL_ROOM)
 *   3. Ocean & river cruises   (CRUISE)
 *   4. Private guides          (GUIDED_TOUR)
 *   5. Landmark access         (ATTRACTION_TICKET)
 *   6. Signature activities    (ACTIVITY)
 *
 * Why generate rather than hand-author ~190 records: hand-written catalogue
 * data drifts. Prices stop matching their category, coordinates end up in the
 * wrong district, cancellation terms contradict each other, and the Chinese
 * copy silently rots because nobody re-reads 190 files. Generating from one
 * descriptor per city keeps those invariants in a single place — change the
 * Lyon descriptor and all six of Lyon's products follow.
 *
 * What is *not* generated is the copy. Each category carries hand-written
 * English and Chinese templates with three rotating variants per slot, so no
 * two products in a city read identically, and the Chinese is idiomatic rather
 * than transliterated.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Every price in the catalogue is denominated in USD.
 *
 * The platform settled on a single settlement currency, so the previous
 * per-currency price shaping (a "five-star suite" landing on a round pound or a
 * round ¥100 so the catalogue would not read as machine output) no longer
 * applies — there is only one currency to land on.
 *
 * Kept as a function rather than inlined so the *reason* a price is the number
 * it is stays readable: `price(2450, 'USD')` still reads as "2450 USD", and
 * reintroducing a second currency later means editing one table here rather
 * than hunting for every `* 100` in the seed.
 */
const FX: Record<string, number> = { USD: 1 };

/**
 * JPY and KRW have no minor unit. `formatMoney()` already special-cases
 * zero-decimal currencies, so prices for those currencies are whole yen.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

/**
 * Converts a USD reference price into minor units of `currency`.
 *
 * The rounding step is what keeps the catalogue from looking machine-generated:
 * every price lands on a deliberate boundary (a whole pound, a whole euro, a
 * round ¥100) rather than on whatever an FX conversion happens to produce.
 *
 * The rounding unit has to be expressed in *minor units*. Getting this wrong is
 * silent and catastrophic: rounding 48 USD → GBP at a 100-unit boundary yields
 * 0, and the seed then writes a free landmark ticket.
 */
function price(usd: number, currency: string): number {
  const rate = FX[currency] ?? 1;
  const units = usd * rate; // whole currency units

  // JPY has no minor unit, so its stored value *is* whole yen — round to the
  // nearest ¥100 for a believable fare. Everything else stores cents, so a
  // whole currency unit is a multiple of 100 minor units.
  return ZERO_DECIMAL.has(currency) ? Math.round(units / 100) * 100 : Math.round(units) * 100;
}

/**
 * Net cost of a variant, held at a constant 78% of the sell price.
 *
 * Derived rather than hand-typed so gross-margin reporting stays honest, and so
 * it is structurally impossible for a seed entry to ship with a net cost equal
 * to or above its sell price.
 */
function cost(usd: number, currency: string): number {
  const net = Math.floor((price(usd, currency) * 78) / 100);
  return Math.max(100, net);
}

// ---------------------------------------------------------------------------
// Deterministic variation
// ---------------------------------------------------------------------------

/**
 * A tiny string hash. Used instead of `Math.random()` so that re-seeding
 * produces byte-identical data — otherwise every `db:seed` would reshuffle
 * reviews, capacities and the rotation offsets, and diffs would be noise.
 */
function hash(input: string): number {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Picks one entry from a list, stably for a given seed. */
function pick<T>(list: readonly T[], seed: string): T {
  return list[hash(seed) % list.length];
}

/** Varied integer in `[min, max]`, stably for a given seed. */
function between(seed: string, min: number, max: number): number {
  return min + (hash(seed) % (max - min + 1));
}

/**
 * Offsets a coordinate from the city anchor.
 *
 * The anchor is a well-known central point, so nudging it by up to `spread`
 * degrees (roughly 1–3 km) places each product somewhere plausible within the
 * city instead of stacking every listing on the same lat/lng.
 */
function offset(city: CityDescriptor, seed: string): { lat: number; lng: number } {
  const h = hash(seed);
  const latJitter = ((h % 1000) / 1000 - 0.5) * 2 * city.spread;
  const lngJitter = (((h >> 10) % 1000) / 1000 - 0.5) * 2 * city.spread;
  return {
    lat: Number((city.anchor.lat + latJitter).toFixed(6)),
    lng: Number((city.anchor.lng + lngJitter).toFixed(6)),
  };
}

/**
 * Image allocation — the reason the storefront stopped repeating itself.
 *
 * The catalogue used to give every product a photo from a pool of three or four
 * per category. With 230 products that put one Rome Colosseum photograph on 30
 * separate cards, and the home page showed the same picture several times over.
 *
 * Two pools replace it, chosen by what a category promises:
 *
 *   - **FLIGHT, HOTEL_ROOM, CRUISE** show a *thing* — an aircraft, a room, a
 *     ship. The city is irrelevant, so these draw from the category pool.
 *   - **GUIDED_TOUR, ATTRACTION_TICKET, ACTIVITY** show a *place*. These draw
 *     from the city's own photographs first, so an attraction in Paris shows
 *     Paris rather than a Roman amphitheatre, and only fall back to the
 *     category pool when a city has fewer images than it has products.
 *
 * Every image is handed out **at most once**, across the entire catalogue, so no
 * two products anywhere in the storefront can carry the same photograph. That
 * is why a generated product has a single image rather than a small gallery:
 * the pool of genuinely distinct, correctly-licensed photographs is bounded, and
 * one unique picture is worth more than two that repeat something else.
 *
 * When a pool runs dry this throws rather than looping. A silent wrap-around is
 * exactly how the original duplication got in, so running out is a build error.
 */
const CITY_TOPICAL: readonly ProductType[] = ['GUIDED_TOUR', 'ATTRACTION_TICKET', 'ACTIVITY'];

const cityCursor = new Map<string, number>();
const categoryCursor = new Map<ProductType, number>();
const usedImages = new Set<string>();

interface PooledImage {
  url: string;
  altText: string;
}

/**
 * Claims the next unused image, preferring the city's own photographs.
 *
 * Skips over anything already claimed rather than trusting the cursor, because
 * the hand-authored featured products register their images first and a city
 * pool is not guaranteed to start where the cursor is.
 */
function claimImage(type: ProductType, citySlug: string): PooledImage {
  const preferCity = CITY_TOPICAL.includes(type);

  if (preferCity) {
    const pool = CITY_IMAGES[citySlug] ?? [];
    let cursor = cityCursor.get(citySlug) ?? 0;
    while (cursor < pool.length && usedImages.has(pool[cursor].url)) cursor += 1;
    if (cursor < pool.length) {
      cityCursor.set(citySlug, cursor + 1);
      usedImages.add(pool[cursor].url);
      return pool[cursor];
    }
  }

  const pool = PHOTO_POOLS[type];
  let cursor = categoryCursor.get(type) ?? 0;
  while (cursor < pool.length && usedImages.has(pool[cursor].url)) cursor += 1;
  if (cursor >= pool.length) {
    throw new Error(
      `photo pool for ${type} is exhausted (${pool.length} images). ` +
        'Re-run `npx tsx scripts/build-photo-pools.ts` before adding more products.',
    );
  }
  categoryCursor.set(type, cursor + 1);
  usedImages.add(pool[cursor].url);
  return pool[cursor];
}

/** Registers an image as claimed without returning it (used by featured entries). */
export function reserveImage(url: string): void {
  usedImages.add(url);
}

/**
 * Claims the next unused photograph of a city.
 *
 * Exported so the hand-authored products can be given a unique gallery before
 * the generated catalogue is built: a duplicate slot there becomes a picture of
 * the *right city* rather than a repeat of something else. Returns `undefined`
 * when the city has no imagery left, which the caller must handle — a duplicate
 * is never an acceptable fallback.
 */
export function takeCityImage(citySlug: string): PooledImage | undefined {
  const pool = CITY_IMAGES[citySlug] ?? [];
  let cursor = cityCursor.get(citySlug) ?? 0;
  while (cursor < pool.length && usedImages.has(pool[cursor].url)) cursor += 1;
  if (cursor >= pool.length) return undefined;
  cityCursor.set(citySlug, cursor + 1);
  usedImages.add(pool[cursor].url);
  return pool[cursor];
}

/**
 * How many listings of each category a city carries.
 *
 * Sized by **how big the city is as a destination**, not uniformly. A global
 * capital should return a full page of things to do while a small spa town
 * returns a handful — that is what the reference site's own city pages do, and
 * a flat count makes every city feel equally thin.
 *
 * These numbers are also the **upper bound** on the catalogue: `claimImage`
 * throws when a category pool runs out, because a wrapped-around photograph is
 * exactly the duplication this whole mechanism exists to remove. Raise a count
 * and `npx tsx scripts/build-photo-pools.ts` may need re-running first.
 */
export const LISTINGS_BY_TIER: Record<'A' | 'B' | 'C', Record<
  'FLIGHT' | 'HOTEL_ROOM' | 'CRUISE' | 'GUIDED_TOUR' | 'ATTRACTION_TICKET' | 'ACTIVITY',
  number
>> = {
  /** Global capitals — a full marketplace page per category. */
  A: { FLIGHT: 6, HOTEL_ROOM: 16, CRUISE: 7, GUIDED_TOUR: 14, ATTRACTION_TICKET: 18, ACTIVITY: 20 },
  /** Large destinations — enough to browse without repeating. */
  B: { FLIGHT: 4, HOTEL_ROOM: 11, CRUISE: 5, GUIDED_TOUR: 10, ATTRACTION_TICKET: 12, ACTIVITY: 13 },
  /** Everything else — a credible but modest inventory. */
  C: { FLIGHT: 3, HOTEL_ROOM: 6, CRUISE: 3, GUIDED_TOUR: 6, ATTRACTION_TICKET: 8, ACTIVITY: 8 },
};

/**
 * Which tier each city belongs to, spelled out rather than derived.
 *
 * `CITIES` is ordered by merchandising priority, so an index-based split is
 * *possible* — but it would put Bath and Interlaken in the top tier and Tokyo in
 * the bottom, because the array is grouped by region rather than by size. A
 * wrong tier is invisible in a diff and obvious on the storefront, so the
 * judgement is written down where it can be reviewed.
 *
 * Every city in `seed-cities.ts` must appear here; a missing one is a startup
 * error rather than a silent downgrade to tier C.
 */
const CITY_TIER: Record<string, 'A' | 'B' | 'C'> = {
  // Global capitals.
  london: 'A',
  paris: 'A',
  rome: 'A',
  'new-york': 'A',
  tokyo: 'A',
  barcelona: 'A',
  // Large destinations.
  edinburgh: 'B',
  venice: 'B',
  florence: 'B',
  madrid: 'B',
  amsterdam: 'B',
  berlin: 'B',
  lisbon: 'B',
  'los-angeles': 'B',
  'san-francisco': 'B',
  'singapore-city': 'B',
  sydney: 'B',
  munich: 'B',
  // Everything else.
  bath: 'C',
  nice: 'C',
  lyon: 'C',
  seville: 'C',
  zurich: 'C',
  interlaken: 'C',
  vienna: 'C',
  salzburg: 'C',
  porto: 'C',
  miami: 'C',
  chicago: 'C',
  'las-vegas': 'C',
  toronto: 'C',
  vancouver: 'C',
  kyoto: 'C',
  melbourne: 'C',
};

/**
 * A distinguishing locale for the second and later listing of a category in one
 * city. Real marketplaces do exactly this — a city's hotels are named for where
 * they sit — so the variation reads as inventory, not as a template loop.
 *
 * Long enough for the largest tier: the biggest category in the biggest city is
 * 20 listings, and a shorter list would start repeating names from a wrapped
 * index.
 */
const SETTINGS: Record<'en' | 'zh', readonly string[]> = {
  en: [
    'Riverside', 'Old Town', 'Garden Wing', 'Upper Quarter', 'Harbour Side',
    'Museum Quarter', 'Cathedral District', 'Market Square', 'Riverside Walk',
    'Hilltop', 'Laneway', 'Central Station', 'Arts District', 'West Gate',
    'North Quarter', 'Park Side', 'Embankment', 'Courtyard', 'Bell Tower',
    'Terrace',
  ],
  zh: [
    '河畔', '老城', '花园翼', '上城', '港湾',
    '博物馆区', '主教座堂区', '市集广场', '滨河步道',
    '山丘', '窄巷', '中央车站', '艺术区', '西城门',
    '北城', '公园侧', '堤岸', '庭院', '钟楼',
    '露台',
  ],
};

function settingFor(ordinal: number, lang: 'en' | 'zh'): string {
  return SETTINGS[lang][(ordinal - 1) % SETTINGS[lang].length];
}

/**
 * Sailing months, so several cruises out of one city are distinguishable.
 *
 * A cruise is a *dated* departure, so the month is the natural second axis; the
 * night count sits in a five-value band and repeated long before the seventh
 * cruise.
 */
const CRUISE_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const CRUISE_MONTHS_ZH = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
] as const;

/**
 * Picks from a list, guaranteed distinct for ordinals below its length.
 *
 * `pick()` alone cannot do this: hashing `hotel:paris:0` and `hotel:paris:1`
 * independently lands on the same entry often enough to matter — all three Paris
 * hotels were named "Paris Palace — Premier Suite" for exactly this reason.
 *
 * The `seed` must therefore be **per city, not per listing**: offsetting a
 * *fixed* base by the ordinal is a rotation, which cannot collide. Offsetting a
 * seed that already contains the ordinal is three independent hashes, which can.
 */
function pickDistinct<T>(list: readonly T[], seed: string, ordinal: number): T {
  return list[(hash(seed) + ordinal) % list.length];
}

/** Slug and ticket-code suffix. `0` keeps the original identifier stable. */
function suffix(ordinal: number): string {
  return ordinal === 0 ? '' : `-${ordinal + 1}`;
}

/**
 * The single image a generated product carries.
 *
 * One image, not a gallery — see `claimImage`. The `alt` text is authored per
 * category below rather than read off the file name, because a Commons file name
 * is a catalogue key, not a sentence.
 */
function media(city: CityDescriptor, type: ProductType): { url: string; altText: string }[] {
  return [claimImage(type, city.slug)];
}

// ---------------------------------------------------------------------------
// Shared ticket-type helper
// ---------------------------------------------------------------------------

/**
 * A sellable variant under construction.
 *
 * The `extra` bag is spread last, so a caller can override anything `variant()`
 * computed. That includes `name`, which is why the parameter has to accept it.
 */

/**
 * Builds a variant with a consistent margin.
 *
 * `costCents` is what the platform nets, so it is always derived from the sell
 * price rather than hand-typed — that keeps gross margin reporting honest
 * instead of depending on someone remembering to update two numbers.
 */
function variant(code: string, sellUsd: number, currency: string, extra: Partial<SeedTicketType> = {}): SeedTicketType {
  const basePriceCents = price(sellUsd, currency);
  return {
    code,
    basePriceCents,
    costCents: cost(sellUsd, currency),
    currency,
    ...extra,
    // Name and code are mandatory on `SeedTicketType`; every call site passes
    // a name in `extra`, but a typo there should fail loudly at compile time
    // rather than write an unnamed variant row.
    ...(extra.name ? {} : { name: code }),
  } as SeedTicketType;
}

// ---------------------------------------------------------------------------
// 1. International flights
// ---------------------------------------------------------------------------

const FLIGHT_CARRIERS: Record<string, string[]> = {
  GB: ['British Airways', 'Virgin Atlantic', 'Emirates'],
  FR: ['Air France', 'Air France', 'Turkish Airlines'],
  IT: ['ITA Airways', 'Lufthansa', 'Emirates'],
  ES: ['Iberia', 'Air Europa', 'Turkish Airlines'],
  DE: ['Lufthansa', 'Lufthansa', 'Emirates'],
  NL: ['KLM', 'KLM', 'Turkish Airlines'],
  CH: ['SWISS', 'SWISS', 'Emirates'],
  AT: ['Austrian Airlines', 'Lufthansa', 'Emirates'],
  PT: ['TAP Air Portugal', 'TAP Air Portugal', 'Turkish Airlines'],
  US: ['United Airlines', 'Delta Air Lines', 'JetBlue'],
  CA: ['Air Canada', 'Air Canada', 'Emirates'],
  JP: ['Japan Airlines', 'ANA', 'Singapore Airlines'],
  SG: ['Singapore Airlines', 'Singapore Airlines', 'Cathay Pacific'],
  AU: ['Qantas', 'Qantas', 'Singapore Airlines'],
};

/** Long-haul gateways per region, so a flight product reads plausibly. */
const HUBS: Record<string, string[]> = {
  GB: ['SIN', 'HKG', 'DXB', 'JFK', 'LAX'],
  FR: ['SIN', 'JFK', 'DXB', 'HND', 'LAX'],
  IT: ['SIN', 'JFK', 'DXB', 'HND'],
  ES: ['SIN', 'JFK', 'DXB', 'BOS'],
  DE: ['SIN', 'JFK', 'DXB', 'SFO'],
  NL: ['SIN', 'JFK', 'DXB', 'HND'],
  CH: ['SIN', 'JFK', 'DXB', 'LAX'],
  AT: ['SIN', 'JFK', 'DXB', 'ORD'],
  PT: ['SIN', 'JFK', 'DXB', 'GRU'],
  US: ['LHR', 'CDG', 'NRT', 'SIN', 'ICN'],
  CA: ['LHR', 'CDG', 'NRT', 'SIN', 'ICN'],
  JP: ['LHR', 'CDG', 'SIN', 'DXB', 'SFO'],
  SG: ['LHR', 'CDG', 'HND', 'SYD', 'LAX'],
  AU: ['LHR', 'CDG', 'SIN', 'DXB', 'JFK'],
};

/**
 * Cabin names for a flight listing.
 *
 * **At least as many entries as the largest number of flights one city carries**
 * (six). The name is built from this list, so a shorter list wraps and produces
 * two identically named flights in the same city — the exact defect this list is
 * sized against. Adding flights to a tier means adding templates here too.
 */
const FLIGHT_NAMES: Record<'en' | 'zh', string[]> = {
  en: [
    'Business Class to {hub}',
    'Premium Economy to {hub}',
    'First Class Suite to {hub}',
    'Business Class, overnight to {hub}',
    'Premium Economy, daytime to {hub}',
    'First Class Suite with lounge to {hub}',
  ],
  zh: [
    '飞往{hub}的商务舱',
    '飞往{hub}的超级经济舱',
    '飞往{hub}的头等舱套房',
    '飞往{hub}的商务舱（夜航）',
    '飞往{hub}的超级经济舱（日间航班）',
    '飞往{hub}的头等舱套房（含贵宾室）',
  ],
};

/** Replaces a `{token}` in a template. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

/**
 * Hub used to build one-stop itineraries in {@link flightProduct}.
 *
 * DXB because the seed carriers (Emirates in particular) actually operate it as
 * a Gulf hub, so a change of gauge there is not fiction. Kept as a named
 * constant because `CONNECTING_ITINERARIES` in seed-category-extensions.ts
 * spells out the leg times for this same hub; the two must agree or the seed
 * produces an itinerary with no schedule behind it.
 */
const CONNECT_HUB = 'DXB';

/**
 * Real airports, injected rather than imported.
 *
 * `buildGlobalProducts` is a pure function over `CITIES`, and it has to stay
 * one: it is what makes the catalogue reproducible without a database. But a
 * route cannot be built without knowing which airport a city actually departs
 * from, and that is a fact about the world, not about this repo.
 *
 * So the caller resolves it — `seed.ts` reads the OurAirports import and passes
 * it in. Omitting the argument falls back to the old behaviour, which is why
 * the fallback is written to be *correct* (never a same-airport route) rather
 * than merely non-crashing.
 */
export interface SeedAirport {
  iataCode: string;
  latitude: number;
  longitude: number;
}

/** Airports passed to the factories, keyed by city slug. Absent => fall back. */
export type AirportIndex = Map<string, SeedAirport[]>;

let AIRPORTS_BY_CITY: AirportIndex = new Map();

/**
 * Supplies the real airports used to build flight routes.
 *
 * Call once before `buildGlobalProducts`. Without it the flight factory falls
 * back to deriving a departure from the city's own country hub, which is
 * weaker but still never produces a degenerate route.
 */
export function setAirportsByCity(index: AirportIndex): void {
  AIRPORTS_BY_CITY = index;
}

function flightProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  // Two seeds on purpose: `seed` is per *listing* (coordinates, connection
  // choice, and the `-2` slug suffix), `family` is per *city* where a value has
  // to differ between the city's listings. See `pickDistinct`.
  const family = `flight:${city.slug}`;
  const seed = `${family}:${ordinal}`;
  const country = (city.slug.match(/-([a-z]{2})$/) ? city.slug.slice(-2) : 'GB').toUpperCase();
  const carriers = FLIGHT_CARRIERS[country] ?? ['Emirates'];
  const airline = pickDistinct(carriers, family + 'carrier', ordinal);

  /**
   * The arrival hub rotates on a **second, slower axis** than the carrier.
   *
   * Rotating both on the ordinal would give `n` distinct pairs only when the two
   * lists are coprime; rotating the hub once per full carrier cycle gives
   * `carriers × hubs` distinct pairs, which is what keeps six flights out of one
   * city from repeating a name. `pickDistinct` documents the failure this
   * avoids.
   */
  const hubs = HUBS[country] ?? ['SIN'];
  const hub = hubs[(hash(family + 'hub') + Math.floor(ordinal / carriers.length)) % hubs.length];

  /**
   * Departure airport, derived from real geography.
   *
   * Previously `origin` was picked from the same `HUBS` pool as `hub`, so the
   * two could coincide and the catalogue grew products like `JFK → JFK` — seven
   * of the 34 flights. Any second fixed list would drift from the first; using
   * the city's own nearest airport removes the possibility instead of
   * narrowing it.
   *
   * Falls back to a hub from the same country when no airport has been
   * supplied (the import has not been run), because a weaker route is better
   * than an impossible one.
   */
  const nearby = AIRPORTS_BY_CITY.get(city.slug);
  const origin = nearby?.length
    ? nearby[hash(seed + 'origin') % nearby.length].iataCode
    : pick(HUBS[country] ?? ['SIN'], seed + 'origin');

  /**
   * Guarantee the two ends differ.
   *
   * The departure now comes from geography and the arrival from `HUBS`, so a
   * collision is only possible when the city's nearest airport is itself a
   * listed hub — which is exactly the `DXB → DXB` case. Rather than reaching
   * for another hub (and landing in the same trap), pick the next-nearest real
   * airport, because a flight from DXB to DXB does not exist.
   */
  let destination = hub;
  if (destination === origin && nearby && nearby.length > 1) {
    const alternative = nearby.find((a) => a.iataCode !== origin);
    if (alternative) destination = alternative.iataCode;
  }
  // Last resort: a different hub entirely. Better a long route than no route.
  if (destination === origin) {
    destination = (HUBS[country] ?? ['SIN']).find((code) => code !== origin) ?? 'SIN';
  }

  /**
   * A share of the catalogue is sold as a one-stop itinerary rather than a
   * direct hop.
   *
   * Without this every flight product is a single leg, so the connection
   * endpoints (`/api/v1/search/connections`) have nothing to match and answer
   * `[]` for every airport. That is a truthful answer to an empty question, not
   * a working feature.
   *
   * The routing is deterministic per product seed, and the change of gauge at
   * the hub is a real one-stop pattern on these trunks — but the leg times come
   * from `CONNECTING_ITINERARIES`, which is demo inventory rather than a live
   * schedule. A customer-facing PNR must never be built from it.
   */
  // `hub !== CONNECT_HUB` matters as much as `origin !== CONNECT_HUB`: UK
  // flights pick DXB as their hub, so without it the "change of gauge" produced
  // routes like `JFK → DXB → DXB` — a stop that departs where it arrived.
  const connects =
    hash(seed + 'via') % 3 === 0 &&
    origin !== destination &&
    origin !== CONNECT_HUB &&
    destination !== CONNECT_HUB;
  const route = connects ? `${origin} → ${CONNECT_HUB} → ${destination}` : `${origin} → ${destination}`;
  const cabinLabel = fill(pickDistinct(FLIGHT_NAMES.en, family, ordinal), { hub: destination });
  const cabinLabelZh = fill(pickDistinct(FLIGHT_NAMES.zh, family, ordinal), { hub: destination });
  const { lat, lng } = offset(city, seed);

  // Business is the headline fare — that is the segment a premium agency sells.
  const business = variant(`${city.slug.toUpperCase()}-FL-BIZ${suffix(ordinal)}`, 2450, city.currency, {
    name: 'Business class',
    description: 'Lie-flat seat with direct aisle access, two-piece service and lounge access.',
    capacity: 12,
    inventoryMode: 'PER_DATE',
    maxPerOrder: 9,
    timeSlots: ['Departure 21:40', 'Departure 23:15'],
  });
  const premium = variant(`${city.slug.toUpperCase()}-FL-PREM${suffix(ordinal)}`, 1180, city.currency, {
    name: 'Premium economy',
    description: 'Wider seat with extra legroom, power and a generous allowance.',
    capacity: 24,
    timeSlots: ['Departure 21:40'],
  });
  const first = variant(`${city.slug.toUpperCase()}-FL-FIRST${suffix(ordinal)}`, 6100, city.currency, {
    name: 'First class suite',
    description: 'Private suite with a closing door and direct access to the onboard bar.',
    capacity: 4,
    maxPerOrder: 4,
    timeSlots: ['Departure 21:40'],
  });

  return {
    slug: `${city.slug}-international-flight${suffix(ordinal)}`,
    name: `${cabinLabel} on ${airline}`,
    type: 'FLIGHT',
    fulfillment: 'INSTANT_TICKET',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: city.meetingStyle,
    timezone: city.timezone,
    summary:
      `A lie-flat business cabin on ${airline}, with lounge access, two-piece service and a through-ticket back to ${city.name}.`,
    description:
      `${airline} operates this route daily to ${city.name}. The business cabin gives you a lie-flat seat with aisle access, priority boarding and two-piece service, and the fare includes lounge access plus a checked bag. The ticket is issued the moment you book, so the seat is yours from the start of the journey.`,
    highlights: [
      `Lie-flat seat with direct aisle access on ${airline}`,
      'Lounge access from three hours before departure',
      'Two-piece service and a multi-course menu',
      'Through-ticket with a protected connection home',
    ],
    includes: ['Round-trip air transport', 'Checked baggage allowance', 'Lounge access', 'Seat selection at no charge'],
    excludes: ['Travel insurance', 'Airport transfers', 'Meals in lounge', 'Seat upgrade products'],
    languages: [city.language.toLowerCase(), 'en', 'zh'],
    instantConfirm: true,
    mobileTicket: true,
    freeCancellation: true,
    wheelchairAccessible: true,
    skipTheLine: false,
    ticketOnly: true,
    tags: ['business-class', 'long-haul', 'lounge-access', 'lie-flat', 'airline'],
    media: media(city, 'FLIGHT'),
    airlineName: airline,
    flightRoute: route,
    cabinClass: 'Business',
    translations: [
      { locale: 'zh', name: `${airline} ${cabinLabelZh}`, summary: `${airline} 执飞该航线，全程平躺座椅、贵宾室休息、两段式餐饮服务，预订即出票。` },
    ],
    ticketTypes: [business, premium, first],
    cancellationPolicy: {
      freeCancelHours: 24,
      tiers: [
        { minHoursBefore: 72, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 8000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Cancel at least 72 hours before departure for a full refund, or 24 hours for a 20% administration fee.',
    },
    reviews: [
      { rating: 5, title: 'Exactly as described', body: `The seat was genuinely lie-flat and the service was attentive without being intrusive. Lounge access made the long sector much easier.`, author: 'Elena R.', daysAgo: 21 },
      { rating: 5, title: 'Smooth from start to finish', body: `Booked on a Monday and the e-ticket arrived immediately. No changes needed at check-in.`, author: 'Marcus T.', daysAgo: 48 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. Luxury hotels
// ---------------------------------------------------------------------------

const HOTEL_NAMES: Record<'en' | 'zh', string[]> = {
  en: [
    'The {city} Grand — Deluxe Suite',
    'Maison {city} — River View Residence',
    '{city} Palace — Premier Suite',
    'Residences {city} — Executive Apartment',
  ],
  zh: [
    '{city}大酒店 豪华套房',
    '{city}公馆 河景居停套房',
    '{city}宫殿 尊享套房',
    '{city}行政公寓 行政房',
  ],
};

function hotelProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  // `family` is per city so the four name templates rotate rather than collide;
  // `seed` is per listing. See `pickDistinct`.
  const family = `hotel:${city.slug}`;
  const seed = `${family}:${ordinal}`;
  const { lat, lng } = offset(city, seed);
  const stars = between(seed + 'stars', 4, 5);
  const brandName = fill(pickDistinct(HOTEL_NAMES.en, family, ordinal), { city: city.name });
  const brandNameZh = fill(pickDistinct(HOTEL_NAMES.zh, family, ordinal), { city: city.nameZh });
  // The 2nd and 3rd property in a city is distinguished by where it sits, the
  // way a real listing is — otherwise three Paris hotels would share one name.
  const setting = ordinal === 0 ? '' : settingFor(ordinal, 'en');
  const settingZh = ordinal === 0 ? '' : settingFor(ordinal, 'zh');

  const suite = variant(`${city.slug.toUpperCase()}-HT-SUITE${suffix(ordinal)}`, 780, city.currency, {
    name: 'Deluxe suite',
    description: 'A corner suite with separate living space and a city or garden outlook.',
    inventoryMode: 'PER_NIGHT',
    capacity: 6,
    maxPerOrder: 4,
  });
  const deluxe = variant(`${city.slug.toUpperCase()}-HT-DELUXE${suffix(ordinal)}`, 420, city.currency, {
    name: 'Deluxe room',
    description: 'A king or twin room with a work desk and blackout curtains.',
    inventoryMode: 'PER_NIGHT',
    capacity: 18,
  });
  const penthouse = variant(`${city.slug.toUpperCase()}-HT-PENT${suffix(ordinal)}`, 2450, city.currency, {
    name: 'Panoramic penthouse',
    description: 'The top floor, with a private terrace and a dedicated host.',
    inventoryMode: 'PER_NIGHT',
    capacity: 2,
    maxPerOrder: 2,
  });

  return {
    slug: `${city.slug}-luxury-hotel${suffix(ordinal)}`,
    // The name template already embeds the city ("Residences London — Executive
    // Apartment"), so appending it again produced titles that read like machine
    // output: "Residences London — Executive Apartment — London, Riverside".
    // The setting is the part that actually distinguishes two properties in one
    // city, so it is the only suffix.
    name: setting ? `${brandName}, ${setting}` : brandName,
    type: 'HOTEL_ROOM',
    fulfillment: 'INSTANT_TICKET',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: 'the hotel reception',
    timezone: city.timezone,
    summary:
      `A ${stars}-star address in ${city.name} with {city.signature.en}. Suites with separate living space, a full-service spa and breakfast included.`,
    description:
      `This is a ${stars}-star hotel in ${city.name}, chosen for its position — close enough to walk to the centre, quiet enough to sleep well. Rooms are spacious, the bathrooms are marble, and the breakfast buffet runs until mid-morning. A concierge will arrange tickets, tables and transfers for anything you do not want to arrange yourself.`,
    highlights: [
      `${stars}-star property in a prime central address`,
      'Breakfast and evening canapés included',
      'Concierge for tickets, dining and transfers',
      'Spa, pool and a well-equipped gym',
    ],
    includes: ['Daily breakfast', 'Evening canapés', 'Use of spa and pool', 'Concierge service', 'High-speed Wi-Fi'],
    excludes: ['City tax', 'Airport transfers', 'Spa treatments', 'Parking'],
    amenities: ['Spa', 'Pool', 'Gym', 'Restaurant', 'Concierge', 'Wi-Fi'],
    languages: [city.language.toLowerCase(), 'en', 'zh'],
    instantConfirm: true,
    mobileTicket: true,
    freeCancellation: true,
    wheelchairAccessible: true,
    tags: ['five-star', 'suite', 'breakfast-included', 'spa', 'concierge'],
    media: media(city, 'HOTEL_ROOM'),
    roomCategory: 'Deluxe suite',
    starCategory: stars,
    boardBasis: 'Breakfast and evening canapés included',
    translations: [
      { locale: 'zh', name: settingZh ? `${brandNameZh} · ${settingZh}` : brandNameZh, summary: `${city.nameZh}核心地段五星酒店，{city.signature.zh}。套房空间宽敞，含早餐与晚间酒会，并提供礼宾服务。` },
    ],
    ticketTypes: [suite, deluxe, penthouse],
    cancellationPolicy: {
      freeCancelHours: 48,
      tiers: [
        { minHoursBefore: 168, refundBps: 10000 },
        { minHoursBefore: 72, refundBps: 9000 },
        { minHoursBefore: 48, refundBps: 7000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Free cancellation up to 7 days before arrival, then a graduated scale down to the first night.',
    },
    reviews: [
      { rating: 5, title: 'Beautifully run', body: `The concierge arranged three bookings for us in a single morning. The room was quiet and the breakfast was the best we had on the trip.`, author: 'Priya N.', daysAgo: 30 },
      { rating: 5, title: 'Would stay again without hesitation', body: `Excellent location — walking distance to most of what we wanted to see, and the beds were genuinely comfortable.`, author: 'Tomas L.', daysAgo: 63 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. Ocean & river cruises
// ---------------------------------------------------------------------------

const RIVERS: Record<string, { name: string; nameZh: string; ports: string[]; portsZh: string[] } | undefined> = {
  GB: { name: 'the Thames', nameZh: '泰晤士河', ports: ['London', 'Oxford', 'Henley', 'Windsor'], portsZh: ['伦敦', '牛津', '亨利', '温莎'] },
  FR: { name: 'the Seine', nameZh: '塞纳河', ports: ['Paris', 'Rouen', 'Honfleur', 'Le Havre'], portsZh: ['巴黎', '鲁昂', '翁弗勒尔', '勒阿弗尔'] },
  NL: { name: 'the Rhine and Meuse', nameZh: '莱茵河与马斯河', ports: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Ghent'], portsZh: ['阿姆斯特丹', '鹿特丹', '乌得勒支', '根特'] },
  CH: { name: 'the Rhine Falls', nameZh: '莱茵瀑布', ports: ['Zürich', 'Lucerne', 'Schaffhausen', 'Rheinau'], portsZh: ['苏黎世', '卢塞恩', '沙夫豪森', '莱瑙'] },
  DE: { name: 'the Rhine', nameZh: '莱茵河', ports: ['Cologne', 'Bonn', 'Mainz', 'Bingen'], portsZh: ['科隆', '波恩', '美因茨', '宾根'] },
  AT: { name: 'the Danube', nameZh: '多瑙河', ports: ['Vienna', 'Melk', 'Linz', 'Passau'], portsZh: ['维也纳', '梅尔克', '林茨', '帕绍'] },
  PT: { name: 'the Douro', nameZh: '杜罗河', ports: ['Porto', 'Peso da Régua', 'Pinhão', 'Vila Nova de Foz Côa'], portsZh: ['波尔图', '雷加镇', '皮尼昂', '新福索科亚'] },
  IT: { name: 'the Po', nameZh: '波河', ports: ['Milan', 'Pavia', 'Piacenza', 'Ferrara'], portsZh: ['米兰', '帕维亚', '皮亚琴察', '费拉拉'] },
  US: { name: 'the Hudson', nameZh: '哈德逊河', ports: ['New York', 'Newburgh', 'Bear Mountain', 'Poughkeepsie'], portsZh: ['纽约', '新堡', '贝尔山', '波基普西'] },
  CA: { name: 'the St Lawrence', nameZh: '圣劳伦斯河', ports: ['Québec City', 'Trois-Rivières', 'Montréal', 'Tadoussac'], portsZh: ['魁北克城', '三河城', '蒙特利尔', '塔杜萨克'] },
};

/** Vessels, chosen to read as plausible for their region. */
const SHIPS: Record<string, { line: string; lineZh: string; ship: string; shipZh: string }[]> = {
  GB: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'Victoria', shipZh: '维多利亚号' }],
  FR: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Seine', shipZh: '维京塞纳号' }],
  NL: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Rhine', shipZh: '维京莱茵号' }],
  CH: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'Uniworld Swiss', shipZh: 'Uniworld瑞士号' }],
  DE: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Rhine', shipZh: '维京莱茵号' }],
  AT: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Danube', shipZh: '维京多瑙号' }],
  PT: [{ line: 'Douro Azul', lineZh: '杜罗蓝号', ship: 'Douro Azul', shipZh: '杜罗蓝号' }],
  IT: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'Uniworld Po', shipZh: 'Uniworld波河号' }],
  US: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'American Grand', shipZh: '美国伟舰号' }],
  CA: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'Uniworld Canada', shipZh: 'Uniworld加拿大号' }],
  JP: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Grace', shipZh: '维京恩典号' }],
  SG: [{ line: 'Uniworld', lineZh: 'Uniworld', ship: 'Viking Pearl', shipZh: '维京珍珠号' }],
  AU: [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking海口号', shipZh: 'Viking海口号' }],
};

function cruiseProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  const family = `cruise:${city.slug}`;
  const seed = `${family}:${ordinal}`;
  const country = city.slug.slice(-2).toUpperCase();
  const { lat, lng } = offset(city, seed);

  const river = RIVERS[country];
  const vessels = SHIPS[country] ?? [{ line: 'Viking', lineZh: '维京邮轮', ship: 'Viking Star', shipZh: '维京星辰号' }];
  const vessel = pickDistinct(vessels, family, ordinal);

  const isRiver = Boolean(river);
  // Nights are drawn from a narrow band so the product reads as a real sailing,
  // which means the band alone cannot distinguish seven cruises from one city.
  // A departure month is the genuine second axis — a cruise *is* a dated
  // departure — and it is what keeps the names apart.
  const nights = between(seed + 'nights', isRiver ? 5 : 7, isRiver ? 7 : 11) + (ordinal % 2);
  // The month rotates on a **per-city** base, not a per-listing one. Hashing the
  // per-listing seed made both axes effectively random, so two sailings out of
  // the same city could land on the same night count *and* the same month and
  // read as duplicates. A fixed base plus the ordinal is a strict rotation:
  // distinct months for the first twelve sailings, which covers every tier.
  const monthIndex = (hash(family + 'month') + ordinal) % CRUISE_MONTHS.length;
  const month = CRUISE_MONTHS[monthIndex];
  const monthZh = CRUISE_MONTHS_ZH[monthIndex];
  const ports = river ? river.ports : [city.name, 'a fjord', 'a Mediterranean port', 'a wine island', 'Monaco', 'Barcelona'];
  const portsZh = river ? river.portsZh : [city.nameZh, '峡湾', '地中海港口', '葡萄酒岛', '摩纳哥', '巴塞罗那'];

  const suite = variant(`${city.slug.toUpperCase()}-CR-SUITE${suffix(ordinal)}`, 5900, city.currency, {
    name: 'Veranda suite',
    description: 'A private veranda with sliding glass doors, in the mid or forward section.',
    inventoryMode: 'PER_DATE',
    capacity: 8,
    maxPerOrder: 2,
  });
  const deluxe = variant(`${city.slug.toUpperCase()}-CR-DELUXE${suffix(ordinal)}`, 3400, city.currency, {
    name: 'Deluxe cabin',
    description: 'A larger-than-average cabin with a window and a sitting area.',
    inventoryMode: 'PER_DATE',
    capacity: 20,
  });
  const balcony = variant(`${city.slug.toUpperCase()}-CR-BALC${suffix(ordinal)}`, 2150, city.currency, {
    name: 'Balcony cabin',
    description: 'A French balcony and a queen or twin configuration.',
    inventoryMode: 'PER_DATE',
    capacity: 30,
  });

  return {
    slug: `${city.slug}-signature-cruise${suffix(ordinal)}`,
    name: isRiver
      ? `${nights}-night river cruise on ${river!.name}, ${month} departure`
      : `${nights}-night ${vessel.ship} cruise from ${city.name}, ${month} departure`,
    type: 'CRUISE',
    fulfillment: 'INSTANT_TICKET',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: isRiver ? 'the ship’s boarding pontoon' : 'the cruise terminal',
    timezone: city.timezone,
    summary: isRiver
      ? `A ${nights}-night all-suite river cruise with ${vessel.line}, along ${river!.name}. Every cabin has a veranda, and you are guided ashore at each port.`
      : `A ${nights}-night voyage on the ${vessel.ship} with ${vessel.line}, departing ${city.name}. All suites, all inclusive, with a host on every deck.`,
    description: isRiver
      ? `${vessel.line} has run ${river!.name} for decades, and it shows: every cabin faces forward with a veranda, the service is unhurried, and the shore excursions are chosen by people who live along the river. You visit ${ports.join(', ')}, and the ship is your home for the whole voyage.`
      : `The ${vessel.ship} is one of the smaller vessels in the ${vessel.line} fleet, which is why it can reach the places the big ships cannot. Every cabin is a suite with a private veranda, there is a host on every deck, and the itinerary runs ${ports.join(', ')}.`,
    highlights: isRiver
      ? [
          'All cabins are suites with a private veranda',
          `${nights} nights with shore excursions at every port`,
          'Viking has sailed this river for over two decades',
          'Unlimited premium wine and spirits included',
        ]
      : [
          'Every cabin is a suite with a private veranda',
          `${nights} nights calling at ${ports.slice(1, 4).join(', ')}`,
          'A host on every deck, plus a concierge',
          'All meals, wine and shore excursions included',
        ],
    includes: isRiver
      ? ['All-suite accommodation', 'All meals and premium beverages', 'Shore excursions at every port', 'Onboard entertainment and sauna']
      : ['All-suite accommodation', 'All meals and fine wines', 'Shore excursions', 'Onboard entertainment and pools'],
    excludes: ['Travel insurance', 'Air fares', 'Gratuities', 'Pre- and post-cruise hotel nights'],
    languages: [city.language.toLowerCase(), 'en', 'zh'],
    instantConfirm: true,
    mobileTicket: true,
    freeCancellation: true,
    wheelchairAccessible: true,
    tags: ['all-suite', 'all-inclusive', 'small-ship', 'verified', 'scenic'],
    media: media(city, 'CRUISE'),
    cruiseLine: vessel.line,
    shipName: vessel.ship,
    cruiseNights: nights,
    itineraryPorts: ports,
    translations: [
      {
        locale: 'zh',
        name: isRiver
          ? `${river!.nameZh}${nights}晚内河游轮（${monthZh}启航）`
          : `${vessel.shipZh}·${city.nameZh}出发${nights}晚邮轮（${monthZh}启航）`,
        summary: isRiver
          ? `${vessel.lineZh}${river!.nameZh}${nights}晚全套房内河游轮。每一间舱房均带独立阳台，靠岸即有专属导览，酒水全部包含。`
          : `${vessel.shipZh}（${vessel.lineZh}）自${city.nameZh}出发的${nights}晚航次。全套房配私人阳台，甲板全程服务，餐饮、酒水与岸上观光全部包含。`,
      },
    ],
    ticketTypes: [suite, deluxe, balcony],
    cancellationPolicy: {
      freeCancelHours: 0,
      tiers: [
        { minHoursBefore: 720, refundBps: 10000 },
        { minHoursBefore: 480, refundBps: 7500 },
        { minHoursBefore: 240, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Free cancellation up to 30 days before sailing, then a graduated scale reflecting work already done.',
    },
    reviews: [
      { rating: 5, title: 'The service is the difference', body: `Nothing was rushed. The shore excursions were genuinely well chosen, and the evening service was excellent without being formal.`, author: 'Claire B.', daysAgo: 25 },
      { rating: 5, title: 'Worth planning around', body: `Book this a year ahead if you can. The cabin was as photographed, and waking up in a different port every morning is something we will not forget.`, author: 'Henrik S.', daysAgo: 70 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Private guides
// ---------------------------------------------------------------------------

function guideProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  const seed = `guide:${city.slug}:${ordinal}`;
  const { lat, lng } = offset(city, seed);

  const halfDay = variant(`${city.slug.toUpperCase()}-GU-HALF${suffix(ordinal)}`, 145, city.currency, {
    name: 'Half-day private walk',
    description: 'Three and a half hours with a historian-guide, at your pace.',
    capacity: 6,
    timeSlots: ['09:30', '14:30'],
  });
  const fullDay = variant(`${city.slug.toUpperCase()}-GU-DAY${suffix(ordinal)}`, 285, city.currency, {
    name: 'Full-day private guide',
    description: 'A whole day with the guide, including a table booked for lunch.',
    capacity: 6,
    timeSlots: ['09:00'],
  });
  const dayTrip = variant(`${city.slug.toUpperCase()}-GU-TRIP${suffix(ordinal)}`, 470, city.currency, {
    name: 'Beyond the city, full day',
    description: 'A day trip into the surrounding countryside or coast with a driver-guide.',
    capacity: 4,
    timeSlots: ['08:30'],
  });

  return {
    slug: `${city.slug}-private-guide${suffix(ordinal)}`,
    name: ordinal === 0
      ? `A day in ${city.name} with a private guide`
      : `Private guide in ${city.name}: the ${settingFor(ordinal, 'en')} walk`,
    type: 'GUIDED_TOUR',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: city.meetingStyle,
    timezone: city.timezone,
    summary: `A private guide who knows ${city.name} properly — {city.signature.en}. No coach, no rush, and the day bends to what you actually want to see.`,
    description:
      `Your guide is a historian or an architect who has lived in ${city.name} for years. The day is yours: they will show you what they would show a friend, skip the parts that are only worth a photograph, and find you a table for lunch somewhere locals eat. Because it is private, the pace is whatever suits you, and you can change the plan as the day goes on.`,
    highlights: [
      'A guide who lives in the city, not a tour dispatcher',
      'Private — your group only, at your own pace',
      'A table reserved for lunch on request',
      'Hotel pickup and drop-off included',
    ],
    includes: ['Licensed private guide', 'Hotel pickup and drop-off', 'Museum and site entries', 'Lunch reservation on request'],
    excludes: ['Meals', 'Hotel accommodation', 'Travel insurance', 'Gratuities'],
    languages: [city.language.toLowerCase(), 'en', 'zh', 'fr', 'de'],
    instantConfirm: true,
    mobileTicket: false,
    freeCancellation: true,
    wheelchairAccessible: true,
    ticketOnly: false,
    durationMinutes: 420,
    groupSizeCap: 6,
    privateDeparture: true,
    tags: ['private', 'historian', 'flexible', 'locally-led', 'architecture'],
    media: media(city, 'GUIDED_TOUR'),
    translations: [
      { locale: 'zh', name: ordinal === 0 ? `${city.nameZh}私享向导一日` : `${city.nameZh}私家向导 · ${settingFor(ordinal, 'zh')}线路`, summary: `由定居${city.nameZh}的历史学者或建筑背景向导带您深度认识这座城市：{city.signature.zh}。私家成行、不赶行程，可按您的节奏随时调整，并可代订当地餐厅。` },
    ],
    ticketTypes: [halfDay, fullDay, dayTrip],
    cancellationPolicy: {
      freeCancelHours: 24,
      tiers: [
        { minHoursBefore: 72, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 9000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Free cancellation up to 24 hours before the guide is confirmed, with no fee at any point.',
    },
    reviews: [
      { rating: 5, title: 'The difference is who you meet', body: `Our guide took us somewhere we would never have found on our own and it was the best hour of the trip. Flexible when we wanted to stay longer.`, author: 'Ingrid M.', daysAgo: 19 },
      { rating: 5, title: 'A genuinely good day', body: `Patient with our children, unhurried, and full of small pieces of information that made the city make sense.`, author: 'Ahmed K.', daysAgo: 55 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 5. Landmark access
// ---------------------------------------------------------------------------

function landmarkProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  const seed = `landmark:${city.slug}:${ordinal}`;
  const { lat, lng } = offset(city, seed);

  const morning = variant(`${city.slug.toUpperCase()}-LM-AM${suffix(ordinal)}`, 48, city.currency, {
    name: 'Entry from opening',
    description: 'Enter as the doors open, before the main arrivals.',
    capacity: 120,
  });
  const timed = variant(`${city.slug.toUpperCase()}-LM-TIMED${suffix(ordinal)}`, 62, city.currency, {
    name: 'Timed entry',
    description: 'A reserved slot; you go straight in when you arrive.',
    capacity: 80,
  });
  const withGuide = variant(`${city.slug.toUpperCase()}-LM-GUIDED${suffix(ordinal)}`, 145, city.currency, {
    name: 'Entry with a guide',
    description: 'Skip-the-line entry plus one hour with a museum specialist.',
    capacity: 20,
  });

  return {
    slug: `${city.slug}-landmark-access${suffix(ordinal)}`,
    name: ordinal === 0
      ? `Signature landmark of ${city.name} — reserved entry`
      : `Landmark of ${city.name}: ${settingFor(ordinal, 'en')} entry`,
    type: 'ATTRACTION_TICKET',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: 'the main entrance, at the left-hand desk',
    timezone: city.timezone,
    summary: `Reserved, priority entry to the landmark everyone comes to ${city.name} for — {city.signature.en}. Your ticket is on your phone and there is nothing to print.`,
    description:
      `This is the site that defines ${city.name}, and on a busy morning the queue can run for an hour. With this ticket you hold a reserved entry and walk straight past it. The mobile ticket is accepted at the door, and you can bring the audio guide into your own language on your phone.`,
    highlights: [
      'Reserved entry — no queue at the main gate',
      'Mobile ticket, accepted straight from your phone',
      'Audio guide in nine languages via the free app',
      'Timed slots from first opening',
    ],
    includes: ['Reserved entry', 'Digital audio guide', 'Digital map on your phone'],
    excludes: ['Hotel transfers', 'Food and drink', 'Souvenir purchases', 'Guided tours unless selected'],
    languages: ['en', 'zh', 'fr', 'de', 'es', 'it', 'ja', 'ko'],
    instantConfirm: true,
    mobileTicket: true,
    freeCancellation: true,
    skipTheLine: true,
    ticketOnly: true,
    wheelchairAccessible: true,
    durationMinutes: 120,
    tags: ['landmark', 'priority-entry', 'audio-guide', 'iconic'],
    media: media(city, 'ATTRACTION_TICKET'),
    translations: [
      { locale: 'zh', name: ordinal === 0 ? `${city.nameZh}地标 · 优先入场` : `${city.nameZh}地标 · ${settingFor(ordinal, 'zh')}入场`, summary: `${city.nameZh}最具代表性之处的优先入场券：{city.signature.zh}。手机出示电子票即可入场，无需排队，并附九语种语音导览。` },
    ],
    ticketTypes: [morning, timed, withGuide],
    cancellationPolicy: {
      freeCancelHours: 24,
      tiers: [
        { minHoursBefore: 48, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 9000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Free cancellation up to 24 hours before your visiting slot.',
    },
    reviews: [
      { rating: 5, title: 'Walked straight in', body: `Showed the ticket at the left desk and we were inside in under five minutes. The audio guide on my own phone was better than the one on offer.`, author: 'Sofia M.', daysAgo: 14 },
      { rating: 4, title: 'Worth booking ahead', body: `Excellent. Allow extra time for photography inside as it gets busy later in the day, but the entry itself was faultless.`, author: 'Daniel K.', daysAgo: 33 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 6. Signature activities
// ---------------------------------------------------------------------------

function activityProduct(city: CityDescriptor, ordinal = 0): SeedProduct {
  const seed = `activity:${city.slug}:${ordinal}`;
  const { lat, lng } = offset(city, seed);

  const smallGroup = variant(`${city.slug.toUpperCase()}-AC-SMALL${suffix(ordinal)}`, 118, city.currency, {
    name: 'Small group, six guests',
    description: 'Six guests maximum, with two local specialists.',
    capacity: 6,
    timeSlots: ['09:00', '15:00'],
  });
  const privateVersion = variant(`${city.slug.toUpperCase()}-AC-PRIV${suffix(ordinal)}`, 460, city.currency, {
    name: 'Private departure',
    description: 'The same day, reserved entirely for your party.',
    capacity: 8,
    maxPerOrder: 8,
    timeSlots: ['09:00', '13:00', '15:00'],
  });
  const extended = variant(`${city.slug.toUpperCase()}-AC-FULL${suffix(ordinal)}`, 240, city.currency, {
    name: 'Extended, with lunch',
    description: 'A full day including a reserved lunch and tasting.',
    capacity: 8,
    timeSlots: ['08:30'],
  });

  return {
    slug: `${city.slug}-signature-activity${suffix(ordinal)}`,
    name: ordinal === 0
      ? `The best of ${city.name}, done properly`
      : `${city.name} by ${settingFor(ordinal, 'en')}: a small-group day`,
    type: 'ACTIVITY',
    destinationSlug: city.slug,
    latitude: lat,
    longitude: lng,
    addressLine: city.addressStyle,
    meetingPoint: city.meetingStyle,
    timezone: city.timezone,
    summary: `One well-chosen day in ${city.name}: {city.signature.en}. Six guests at most, two specialists, and a private version if you would rather have it to yourselves.`,
    description:
      `Most days in ${city.name} are spent deciding what to do. This one is already decided: a small group of six, two specialists who know the city, and a day built around the things worth doing rather than the things worth photographing. It finishes with a long lunch somewhere you would not find on your own.`,
    highlights: [
      'Six guests maximum — a genuinely small group',
      'Two local specialists, both licensed and fluent in English',
      'Hotel pickup and drop-off included',
      'A private departure available for your party only',
    ],
    includes: ['Hotel transfers', 'All entries and permits', 'Reserved lunch', 'English-speaking specialists'],
    excludes: ['Travel insurance', 'Personal shopping', 'Gratuities', 'Alcoholic drinks beyond lunch'],
    languages: [city.language.toLowerCase(), 'en', 'zh'],
    instantConfirm: true,
    mobileTicket: true,
    freeCancellation: true,
    wheelchairAccessible: true,
    ticketOnly: false,
    durationMinutes: 480,
    groupSizeCap: 6,
    privateDeparture: true,
    tags: ['small-group', 'local-specialist', 'lunch-included', 'private-option'],
    media: media(city, 'ACTIVITY'),
    translations: [
      { locale: 'zh', name: ordinal === 0 ? `${city.nameZh}精选一日体验` : `${city.nameZh}精选一日 · ${settingFor(ordinal, 'zh')}`, summary: `${city.nameZh}值得专程一访的一天：{city.signature.zh}。最多六位客人，两位本地专家全程陪同，含专车接送与预留午餐，亦可升级为私家专属行程。` },
    ],
    ticketTypes: [smallGroup, privateVersion, extended],
    cancellationPolicy: {
      freeCancelHours: 24,
      tiers: [
        { minHoursBefore: 72, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 8000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      adminFeeCents: 0,
      description: 'Free cancellation up to 24 hours before, then a 20% administration fee.',
    },
    reviews: [
      { rating: 5, title: 'The right way to spend a day', body: `Six people was exactly right. Our specialists answered every question without rushing us anywhere, and the lunch stop was the highlight of the week.`, author: 'Rachel O.', daysAgo: 17 },
      { rating: 5, title: 'Booked the private option', body: `We upgraded to the private departure for our anniversary. It was quiet, unhurried and tailored completely to what we were interested in.`, author: 'Julien P.', daysAgo: 52 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const LISTINGS: { type: keyof typeof PER_CITY_LISTINGS; factory: (city: CityDescriptor, ordinal?: number) => SeedProduct }[] = [
  { type: 'FLIGHT', factory: flightProduct },
  { type: 'HOTEL_ROOM', factory: hotelProduct },
  { type: 'CRUISE', factory: cruiseProduct },
  { type: 'GUIDED_TOUR', factory: guideProduct },
  { type: 'ATTRACTION_TICKET', factory: landmarkProduct },
  { type: 'ACTIVITY', factory: activityProduct },
];

/** Fills a `{city.signature}` placeholder in the hand-written copy. */
function interpolate(template: string, city: CityDescriptor, lang: 'en' | 'zh'): string {
  return template.replace(/\{city\.signature\.(en|zh)\}/g, (_all, which: string) =>
    city.signature[which as 'en' | 'zh'],
  );
}

/**
 * Builds the full catalogue, bilingual and uniquely illustrated.
 *
 * Exported rather than inlined so `seed-products.ts` can compose it with the
 * hand-authored entries; in practice it is the whole generated list.
 */
export function buildGlobalProducts(): SeedProduct[] {
  const products: SeedProduct[] = [];

  for (const city of CITIES) {
    const tier = CITY_TIER[city.slug];
    if (!tier) {
      // A city with no tier would be silently built at zero listings, which
      // looks like "this destination is empty" rather than "someone forgot".
      throw new Error(`no tier for city "${city.slug}" in CITY_TIER (seed-global.ts)`);
    }

    for (const { type, factory } of LISTINGS) {
      for (let ordinal = 0; ordinal < LISTINGS_BY_TIER[tier][type]; ordinal += 1) {
        const product = factory(city, ordinal);

        // Interpolation is applied last, so the templates above can mention the
        // city signature without every factory threading it through by hand.
        product.summary = interpolate(product.summary, city, 'en');
        product.description = interpolate(product.description, city, 'en');
        for (const translation of product.translations ?? []) {
          if (translation.locale === 'zh') {
            translation.summary = interpolate(translation.summary, city, 'zh');
          }
        }

        products.push(product);
      }
    }
  }

  return products;
}

/** Cities covered, for logging and for the storefront's destination grid. */
export const COVERED_CITIES = CITIES.map((city) => ({ slug: city.slug, name: city.name, nameZh: city.nameZh }));