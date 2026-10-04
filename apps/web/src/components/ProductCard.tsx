import Link from 'next/link';
import type { SearchHit } from '@/lib/api';
import { formatMoney, stars } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * Category-aware product card.
 *
 * The catalogue spans six categories — flights, hotels, cruises, private
 * guides, landmark access and signature activities — and a single generic
 * layout flattens all six into the same "image / title / rating / price" row.
 * That sameness is exactly what makes a site read as a ticketing utility rather
 * than a travel consultancy.
 *
 * So each category leads with the one or two facts that actually matter for it:
 *
 *   FLIGHT          route, airline, cabin
 *   HOTEL_ROOM      star rating, board basis
 *   CRUISE          ship, length in nights
 *   GUIDED_TOUR     group size, private availability
 *   ATTRACTION_…    priority entry
 *   ACTIVITY        group size, private availability
 *
 * Two rules hold across all of them:
 *
 *   1. A price never renders without saying what it prices. A hotel rate is per
 *      night, a cruise is per person, a flight is a return fare — labelling a
 *      per-night room "per person" is small dishonesty, and it is the fastest
 *      way to lose a guest's trust.
 *   2. No urgency, scarcity or discount language. The badge comes from the
 *      API; nothing here renders "only N left".
 */

/** Per-category eyebrow label and price unit. */
const CATEGORY_META: Record<string, { label: { en: string; zh: string }; unit: { en: string; zh: string } }> = {
  FLIGHT: { label: { en: 'International flight', zh: '国际机票' }, unit: { en: 'per person, return', zh: '每人往返' } },
  HOTEL_ROOM: { label: { en: 'Hotel & suites', zh: '豪华酒店' }, unit: { en: 'per night', zh: '每晚' } },
  CRUISE: { label: { en: 'Ocean & river cruise', zh: '邮轮与河轮' }, unit: { en: 'per person', zh: '每人' } },
  GUIDED_TOUR: { label: { en: 'Private guide', zh: '私人向导' }, unit: { en: 'per person', zh: '每人' } },
  ATTRACTION_TICKET: { label: { en: 'Landmark access', zh: '殿堂级景点' }, unit: { en: 'per person', zh: '每人' } },
  ACTIVITY: { label: { en: 'Signature experience', zh: '特色体验' }, unit: { en: 'per person', zh: '每人' } },
  DAY_TRIP: { label: { en: 'Day journey', zh: '一日行程' }, unit: { en: 'per person', zh: '每人' } },
  TOUR: { label: { en: 'Guided tour', zh: '导览团' }, unit: { en: 'per person', zh: '每人' } },
  PACKAGE: { label: { en: 'Curated package', zh: '臻选套餐' }, unit: { en: 'per person', zh: '每人' } },
  TRANSFER: { label: { en: 'Transfer', zh: '接送服务' }, unit: { en: 'per vehicle', zh: '每车' } },
  AIRPORT_TRANSFER: { label: { en: 'Airport transfer', zh: '机场接送' }, unit: { en: 'per vehicle', zh: '每车' } },
  RESTAURANT: { label: { en: 'Dining', zh: '餐饮订位' }, unit: { en: 'per person', zh: '每人' } },
  VEHICLE_RENTAL: { label: { en: 'Car hire', zh: '租车服务' }, unit: { en: 'per day', zh: '每天' } },
  RENTAL_CAR: { label: { en: 'Car hire', zh: '租车服务' }, unit: { en: 'per day', zh: '每天' } },
};

function pick(meta: { en: string; zh: string } | undefined, locale: LocaleCode): string {
  if (!meta) return '';
  return locale === 'zh' ? meta.zh : meta.en;
}

/**
 * The one or two facts shown under the title for a given category.
 *
 * Returns an array so the layout stays uniform while each category picks its
 * own content: a flight leads with the route, a hotel with its star rating, a
 * cruise with the ship and its length in nights.
 */
/**
 * True when a route names an intermediate airport.
 *
 * The separator is matched loosely (`→`, `->`, `➜`) because the seeds write it
 * and a supplier feed may write another; what matters is counting airports, not
 * matching one glyph. A two-airport route is a direct hop by definition.
 */
function hasStop(route: string): boolean {
  return route.split(/\s*(?:→|->|➜)\s*/).filter(Boolean).length > 2;
}

function categoryFacts(hit: SearchHit, locale: LocaleCode): string[] {
  const zh = locale === 'zh';
  const c = hit.category;
  if (!c) return [];

  switch (hit.type) {
    case 'FLIGHT': {
      const facts: string[] = [];
      // Say so when the journey stops. A route written "SIN → DXB → JFK" is a
      // one-stop itinerary, and a traveller reading only the airports would
      // otherwise assume it is direct — which changes both the total travel
      // time and the connection risk they are buying.
      if (c.flightRoute && hasStop(c.flightRoute)) {
        facts.push(zh ? '经停' : '1 stop');
      }
      return [...facts, c.flightRoute, c.airlineName, c.cabinClass].filter(
        (v): v is string => Boolean(v),
      );
    }

    case 'HOTEL_ROOM':
      return [
        c.roomCategory,
        c.starCategory ? '★'.repeat(c.starCategory) : null,
        c.boardBasis ? (zh ? '含早餐' : 'Breakfast included') : null,
      ].filter((v): v is string => Boolean(v));

    case 'CRUISE':
      return [
        c.shipName,
        c.cruiseNights ? (zh ? `${c.cruiseNights} 晚` : `${c.cruiseNights} nights`) : null,
        c.cruiseLine,
      ].filter((v): v is string => Boolean(v));

    case 'GUIDED_TOUR':
    case 'ACTIVITY': {
      const parts: string[] = [];
      if (c.groupSizeCap) parts.push(zh ? `最多 ${c.groupSizeCap} 位` : `Up to ${c.groupSizeCap} guests`);
      if (c.privateDeparture) parts.push(zh ? '可私家专享' : 'Private departure available');
      return parts;
    }

    default:
      return [];
  }
}

export function ProductCard({ hit, locale }: { hit: SearchHit; locale: LocaleCode }) {
  const t = createTranslator(locale);
  const zh = locale === 'zh';

  const meta = CATEGORY_META[hit.type];
  const facts = categoryFacts(hit, locale);

  // Trust signals, in order of how much each actually tells a guest. Framed
  // positively: "flexible cancellation" rather than "cancel up to 24h or lose
  // your deposit", which is the same fact with the emphasis inverted.
  const assurances: string[] = [];
  if (hit.freeCancellation) assurances.push(t('search.freeCancellation'));
  if (hit.skipTheLine) assurances.push(t('search.skipTheLine'));
  if (hit.instantConfirm && !hit.freeCancellation && !hit.skipTheLine) {
    assurances.push(t('search.instantConfirm'));
  }

  return (
    <article className="product-card">
      <Link href={`/products/${hit.slug}`} className="product-media" aria-hidden tabIndex={-1}>
        {hit.imageUrl ? (
          // Plain <img> keeps the build dependency-free; Next's image optimiser
          // would need every partner CDN allow-listed.
          <img src={hit.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="product-media-fallback" aria-hidden>
            ✦
          </div>
        )}
        {hit.badge && (
          <span className="product-ribbon" style={{ boxShadow: 'var(--shadow-sm)' }}>
            {hit.badge}
          </span>
        )}
      </Link>

      <div className="product-body">
        {/* Category first, then city: answers "what kind of thing" and "where"
            before the guest commits to reading the title. */}
        <div className="product-eyebrow">
          <span>{pick(meta?.label, locale)}</span>
          {hit.destinationName && (
            <>
              <span className="product-fact-sep">·</span>
              <span>{hit.destinationName}</span>
            </>
          )}
        </div>

        <Link href={`/products/${hit.slug}`} className="product-title">
          {hit.title}
        </Link>

        {facts.length > 0 && (
          <p className="product-facts">
            {facts.map((fact, index) => (
              <span key={fact}>
                {index > 0 && <span className="product-fact-sep"> · </span>}
                {fact}
              </span>
            ))}
          </p>
        )}

        {hit.summary && (
          <p className="product-summary small muted truncate" style={{ maxWidth: '62ch' }}>
            {hit.summary}
          </p>
        )}

        <div className="row wrap" style={{ gap: 'var(--sp-3)' }}>
          {hit.ratingCount > 0 && (
            <span className="rating">
              <span className="rating-stars" aria-hidden>
                {stars(hit.ratingAvg)}
              </span>
              <span className="rating-score">{hit.ratingAvg.toFixed(1)}</span>
              <span className="rating-count">
                {zh
                  ? `${hit.ratingCount.toLocaleString('zh-CN')} 条评价`
                  : `${hit.ratingCount.toLocaleString()} reviews`}
              </span>
            </span>
          )}

          {assurances.map((assurance) => (
            <span key={assurance} className="badge badge-neutral">
              {assurance}
            </span>
          ))}
        </div>
      </div>

      <div className="product-price">
        <div>
          <div className="price-now">{formatMoney(hit.priceCents, hit.currency, locale)}</div>
          {/* The unit is never omitted — see rule 1 above. */}
          <div className="price-note">{pick(meta?.unit, locale) || t('common.perPerson')}</div>
          {hit.distanceKm !== null && <div className="price-note">{t('product.kmAway', hit.distanceKm)}</div>}
        </div>

        <Link
          href={`/products/${hit.slug}`}
          className="btn btn-secondary btn-sm"
          style={{ marginTop: 'var(--sp-3)' }}
        >
          {t('common.viewDeals')}
        </Link>
      </div>
    </article>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="product-card" aria-hidden>
      <div className="skeleton" style={{ width: 232, height: 168, borderRadius: 'var(--r-md)' }} />
      <div className="product-body">
        <div className="skeleton" style={{ height: 12, width: '35%' }} />
        <div className="skeleton" style={{ height: 18, width: '85%' }} />
        <div className="skeleton" style={{ height: 13, width: '100%' }} />
        <div className="skeleton" style={{ height: 13, width: '60%' }} />
      </div>
      <div className="product-price">
        <div className="skeleton" style={{ height: 20, width: 90, marginLeft: 'auto' }} />
        <div className="skeleton" style={{ height: 30, width: 110, marginTop: 'var(--sp-3)' }} />
      </div>
    </div>
  );
}