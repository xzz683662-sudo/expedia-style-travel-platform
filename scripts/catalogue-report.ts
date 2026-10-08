/**
 * Catalogue sanity report.
 *
 * Run with:  npx tsx scripts/catalogue-report.ts
 *
 * Fails loudly (exit 1) on any invariant violation, so it can gate a commit:
 *   - every product resolves to a destination that exists in the seed
 *   - every product has a Chinese translation and at least one photo, and no
 *     two products share a photo
 *   - every city carries the six headline categories
 *   - no duplicate slugs or ticket-type codes
 *   - prices are plausible for their currency (no zero-decimal currency priced
 *     in cents, no sub-cost sell price)
 */
import { DESTINATIONS, MERCHANTS, type SeedProduct } from '../apps/api/prisma/seed-data';
import { PRODUCTS } from '../apps/api/prisma/seed-products';
import { CITIES } from '../apps/api/prisma/seed-cities';

const REQUIRED_CATEGORIES = ['FLIGHT', 'HOTEL_ROOM', 'CRUISE', 'GUIDED_TOUR', 'ATTRACTION_TICKET', 'ACTIVITY'] as const;
const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

/**
 * Plausible price band per category, expressed in **USD-equivalent units**.
 *
 * The catalogue prices each city in its own currency, so a raw comparison
 * against a USD band would fail every JPY and CHF listing (a ¥385,000 business
 * fare is about US$2,450 — correct, not a bug). Normalising back to USD before
 * the check keeps the guard pointed at what it is actually for: catching unit
 * mistakes, not FX variation.
 */
const USD_EQUIVALENT: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, CHF: 0.88,
  CAD: 1.36, AUD: 1.52, SGD: 1.34, JPY: 157,
  KRW: 1360,
};

const PRICE_BAND: Record<string, [number, number]> = {
  FLIGHT: [300, 12_000],
  HOTEL_ROOM: [200, 8_000],
  // A "cruise" spans two very different things: a multi-night voyage at
  // thousands, and a two-hour dinner sail at tens. The floor therefore sits at
  // the cheapest day-sail price, and the per-product voyage band is checked
  // separately below via `cruiseNights`.
  CRUISE: [20, 30_000],
  GUIDED_TOUR: [15, 2_000],
  ATTRACTION_TICKET: [10, 300],
  ACTIVITY: [30, 2_500],
  DAY_TRIP: [60, 3_000],
  TRANSFER: [15, 1_000],
  TOUR: [20, 1_500],
};

/** Lower bound for a multi-night voyage, in USD-equivalent units. */
const VOYAGE_FLOOR = 800;

const issues: string[] = [];

const destinationSlugs = new Set(DESTINATIONS.map((d) => d.slug));
const citySlugs = new Set(CITIES.map((c) => c.slug));
const merchantSlugs = new Set(MERCHANTS.map((m) => m.slug));

// --- global invariants -----------------------------------------------------
const slugs = new Set<string>();
const codes = new Set<string>();
/** Photograph URL -> the product that first claimed it. */
const photoOwner = new Map<string, string>();
/** Reset per product, to catch a gallery repeating one of its own frames. */
const seenInProduct = new Set<string>();
/**
 * "<city>|<type>" -> the names used, so two listings in one city cannot present
 * the same name. The generator rotates name templates, and a rotation shorter
 * than a tier's listing count silently produced identical titles — three Paris
 * hotels all called "Paris Palace — Premier Suite".
 */
const namesPerCityType = new Map<string, Set<string>>();

for (const p of PRODUCTS as SeedProduct[]) {
  if (slugs.has(p.slug)) issues.push(`duplicate product slug: ${p.slug}`);
  slugs.add(p.slug);

  if (!destinationSlugs.has(p.destinationSlug)) {
    issues.push(`${p.slug}: unknown destination "${p.destinationSlug}"`);
  }
  if (p.merchantSlug && !merchantSlugs.has(p.merchantSlug)) {
    issues.push(`${p.slug}: unknown merchant "${p.merchantSlug}"`);
  }
  if (!p.name) issues.push(`${p.slug}: missing display name`);
  if (!/^[a-z0-9-]+$/.test(p.slug)) issues.push(`${p.slug}: slug must be kebab-case`);

  const nameKey = `${p.destinationSlug}|${p.type}`;
  const seenNames = namesPerCityType.get(nameKey) ?? new Set<string>();
  if (seenNames.has(p.name)) issues.push(`${p.slug}: duplicate name "${p.name}" in ${nameKey}`);
  seenNames.add(p.name);
  namesPerCityType.set(nameKey, seenNames);

  const hasZh = (p.translations ?? []).some((t) => t.locale === 'zh');
  if (!hasZh) issues.push(`${p.slug}: missing zh translation`);

  /**
   * One photo is the intended shape, not a shortfall.
   *
   * A generated product carries a single image because the pool of genuinely
   * distinct, correctly-licensed photographs is bounded and the seed refuses to
   * reuse one — see `claimImage`. Two photos that repeat something else is the
   * defect this replaced, so the floor is *one*, and the invariant that matters
   * is the cross-product uniqueness checked below.
   */
  if (p.media.length < 1) issues.push(`${p.slug}: needs at least one photo`);
  for (const m of p.media) {
    if (!m.url.startsWith('https://')) issues.push(`${p.slug}: non-https media url`);
    if (photoOwner.has(m.url)) {
      issues.push(`photo shared by ${photoOwner.get(m.url)} and ${p.slug}: ${m.url.slice(-48)}`);
    } else {
      photoOwner.set(m.url, p.slug);
    }
    // A product repeating its own frame is the same defect one level down: two
    // identical thumbnails sit side by side in the gallery.
    if (seenInProduct.has(m.url)) issues.push(`${p.slug}: repeats its own photo`);
    seenInProduct.add(m.url);
  }
  seenInProduct.clear();

  // Two variants is a legitimate shape (a standard and a concession rate, or a
// day and an evening sailing), so the floor is two rather than three.
if (p.ticketTypes.length < 2) issues.push(`${p.slug}: needs at least two variants`);

  for (const t of p.ticketTypes) {
    if (codes.has(t.code)) issues.push(`duplicate ticket code: ${t.code}`);
    codes.add(t.code);

    const cur = t.currency ?? 'USD';
    // Divide by 100 for two-decimal currencies, by 1 for JPY/KRW — the stored
    // value is minor units, so the divisor is what recovers whole units.
    const unitDivisor = ZERO_DECIMAL.has(cur) ? 1 : 100;
    const usd = t.basePriceCents / unitDivisor / (USD_EQUIVALENT[cur] ?? 1);

    if (t.basePriceCents <= 0) issues.push(`${p.slug}/${t.code}: non-positive price`);
    if (t.costCents >= t.basePriceCents) issues.push(`${p.slug}/${t.code}: cost >= sell price`);

    const band = PRICE_BAND[p.type];
    if (band && (usd < band[0] || usd > band[1])) {
      issues.push(
        `${p.slug}/${t.code}: ~US$${usd.toFixed(0)} outside ${band[0]}–${band[1]} band for ${p.type} (${cur})`,
      );
    }

    // A product declared as a multi-night voyage must be priced like one.
    if (p.type === 'CRUISE' && (p.cruiseNights ?? 0) >= 3 && usd < VOYAGE_FLOOR) {
      issues.push(
        `${p.slug}/${t.code}: ${p.cruiseNights}-night voyage priced at ~US$${usd.toFixed(0)}, below the ${VOYAGE_FLOOR} floor`,
      );
    }
  }

  if (p.cancellationPolicy) {
    const tiers = p.cancellationPolicy.tiers;
    if (!tiers.some((t) => t.refundBps === 10000) && p.cancellationPolicy.freeCancelHours > 0) {
      issues.push(`${p.slug}: free cancellation window but no full-refund tier`);
    }
  }

  // An unresolved interpolation placeholder is a factory bug, not a data gap.
  const blob = [p.name, p.summary, p.description, ...(p.translations ?? []).flatMap((t) => [t.name, t.summary])].join(' ');
  if (/\{city\.signature|\{\w+\}/.test(blob)) issues.push(`${p.slug}: unresolved template placeholder`);
}

// --- per-city category coverage -------------------------------------------
const byCity = new Map<string, Set<string>>();
for (const p of PRODUCTS) {
  if (!byCity.has(p.destinationSlug)) byCity.set(p.destinationSlug, new Set());
  byCity.get(p.destinationSlug)!.add(p.type);
}

for (const city of citySlugs) {
  const types = byCity.get(city);
  if (!types) {
    issues.push(`city ${city}: no products at all`);
    continue;
  }
  const missing = REQUIRED_CATEGORIES.filter((c) => !types!.has(c));
  if (missing.length) issues.push(`city ${city}: missing categories ${missing.join(', ')}`);
}

// --- destinations without a city descriptor -------------------------------
for (const d of DESTINATIONS) {
  if (d.level === 'CITY' && !citySlugs.has(d.slug)) {
    issues.push(`destination ${d.slug}: CITY with no descriptor in seed-cities.ts`);
  }
}

// Legacy featured products for cities dropped from the descriptor list must be
// retargeted or removed; an orphaned `destinationSlug` would fail the seed's
// own lookup and silently produce a product with no city.
const knownDestinations = new Set(DESTINATIONS.map((d) => d.slug));
for (const p of PRODUCTS) {
  if (p.destinationSlug === 'las-vegas' || p.destinationSlug === 'chicago') {
    // These two cities are not in the current destination list. Rather than
    // re-add them, the products are dropped at composition time (see
    // FEATURED_PRODUCTS filter in seed-products.ts).
    if (!knownDestinations.has(p.destinationSlug)) {
      issues.push(`${p.slug}: retargeted from removed city "${p.destinationSlug}"`);
    }
  }
}

// --- report ---------------------------------------------------------------
const byType: Record<string, number> = {};
const byCurrency: Record<string, number> = {};
for (const p of PRODUCTS) {
  byType[p.type] = (byType[p.type] ?? 0) + 1;
  const cur = p.ticketTypes[0]?.currency ?? 'USD';
  byCurrency[cur] = (byCurrency[cur] ?? 0) + 1;
}

console.log('EasyTrip catalogue report');
console.log('========================');
console.log(`cities:        ${citySlugs.size}`);
console.log(
  `destinations:  ${DESTINATIONS.length} (${DESTINATIONS.filter((d) => d.level === 'COUNTRY').length} countries, ${DESTINATIONS.filter((d) => d.level === 'CITY').length} cities)`,
);
console.log(`products:      ${PRODUCTS.length}`);
console.log(`variants:      ${codes.size}`);
console.log(`by type:       ${JSON.stringify(byType)}`);
console.log(`by currency:   ${JSON.stringify(byCurrency)}`);

if (issues.length) {
  console.error(`\n${issues.length} issue(s):`);
  for (const issue of issues.slice(0, 40)) console.error(`  - ${issue}`);
  if (issues.length > 40) console.error(`  ... and ${issues.length - 40} more`);
  process.exit(1);
}

console.log('\nAll invariants hold.');