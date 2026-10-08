import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { api, type AvailabilityDay, type ProductDetail } from '@/lib/api';
import { formatDate, formatMoney, relativeDay, stars } from '@/lib/format';
import { Breadcrumbs, EmptyState, TrustBar } from '@/components/PageShell';
import { BookingPanel } from '@/components/BookingPanel';
import { AvailabilityCalendar } from '@/components/AvailabilityCalendar';
import { ReviewSection } from '@/components/ReviewSection';
import { SaveToWishlistButton } from '@/components/SaveToWishlistButton';
import { SafeImage } from '@/components/SafeImage';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import type { LocaleCode } from '@/lib/i18n/config';

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  const product = await api.product(slug, {}, locale).catch(() => null);
  if (!product) return { title: t('product.notFound') };

  return {
    title: product.name,
    description: product.summary ?? product.name,
    openGraph: {
      title: product.name,
      description: product.summary ?? undefined,
      images: product.media[0]?.url ? [product.media[0].url] : undefined,
    },
  };
}

export default async function ProductPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  const selectedDate = first(query.date);
  const quantity = Number(first(query.quantity) ?? 1);

  const [product, availability] = await Promise.all([
    api.product(slug, { date: selectedDate, quantity }, locale).catch(() => null),
    api.availability(slug, 90).catch(() => ({ from: '', days: [] as AvailabilityDay[] })),
  ]);

  if (!product) notFound();

  const todayIso = new Date().toISOString().slice(0, 10);
  const activeDate = selectedDate ?? todayIso;
  const cheapest = product.ticketTypes.reduce(
    (min, ticketType) => Math.min(min, ticketType.totalPerUnitCents),
    Number.MAX_SAFE_INTEGER,
  );

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-5)', paddingBottom: 'var(--sp-7)' }}>
      <Breadcrumbs
        items={[
          { label: t('nav.experiences'), href: '/search' },
          ...(product.destination
            ? [{ label: product.destination.parent ?? product.destination.name, href: `/search?destination=${product.destination.slug}` }]
            : []),
          ...(product.destination ? [{ label: product.destination.name, href: `/search?destination=${product.destination.slug}` }] : []),
          { label: product.name },
        ]}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Title block                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="row wrap" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
          {product.flags.skipTheLine && (
            <span className="badge badge-brand">{t('search.skipTheLine')}</span>
          )}
          {product.flags.instantConfirm && (
            <span className="badge badge-positive">{t('search.instantConfirm')}</span>
          )}
          {product.flags.freeCancellation && (
            <span className="badge badge-neutral">{t('search.freeCancellation')}</span>
          )}
          {product.flags.mobileTicket && (
            <span className="badge badge-neutral">{t('product.mobileTicket')}</span>
          )}
        </div>

        <div className="row-between wrap" style={{ gap: 'var(--sp-4)' }}>
          <div style={{ maxWidth: 720 }}>
            <h1 style={{ fontSize: 30 }}>{product.name}</h1>
            {product.summary && (
              <p className="muted" style={{ fontSize: 16, marginTop: 'var(--sp-2)' }}>
                {product.summary}
              </p>
            )}
          </div>

          <div className="row wrap" style={{ gap: 'var(--sp-3)' }}>
            <SaveToWishlistButton productId={product.id} serviceDate={selectedDate} locale={locale} />
            {product.rating.count > 0 && (
              <div className="card card-pad center" style={{ minWidth: 130 }}>
                <div className="rating-stars" style={{ fontSize: 17 }} aria-hidden>
                  {stars(product.rating.average)}
                </div>
                <div className="bold" style={{ fontSize: 20 }}>
                  {product.rating.average.toFixed(1)}
                </div>
                <a href="#reviews" className="tiny" style={{ color: 'var(--brand-600)' }}>
                  {t('product.reviewsCount', product.rating.count)}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Gallery                                                           */}
      {/* ------------------------------------------------------------------ */}
      <Gallery media={product.media} name={product.name} morePhotosLabel={t('product.morePhotos')} />

      <div className="with-rail" style={{ marginTop: 'var(--sp-6)' }}>
        {/* ---------------------------------------------------------------- */}
        {/* Main column                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="with-rail-main stack-lg">
          <TrustBar
            items={[
              product.flags.instantConfirm
                ? t('search.instantConfirm')
                : t('product.trustConfirmed24h'),
              product.flags.freeCancellation
                ? t('search.freeCancellation')
                : t('product.trustCancelAvailable'),
              t('product.trustMobile'),
              t('product.trustSecure'),
            ]}
          />

          {/* Highlights */}
          {product.highlights.length > 0 && (
            <section className="card card-pad">
              <h2 style={{ fontSize: 18, marginBottom: 'var(--sp-3)' }}>
                {t('product.whatYoullDo')}
              </h2>
              <ul className="stack-sm" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {product.highlights.map((highlight) => (
                  <li key={highlight} className="row" style={{ alignItems: 'flex-start', gap: 'var(--sp-2)' }}>
                    <span style={{ color: 'var(--success-600)', fontWeight: 800 }} aria-hidden>
                      ✓
                    </span>
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Description */}
          {product.description && (
            <section className="card card-pad">
              <h2 style={{ fontSize: 18, marginBottom: 'var(--sp-3)' }}>
                {t('product.description')}
              </h2>
              <p style={{ whiteSpace: 'pre-line' }}>{product.description}</p>
            </section>
          )}

          {/* Live air traffic. Ambient context only — see `LiveContent.advisory`. */}
          {product.live?.summary && (
            <section className="card card-pad" data-live-content={product.slug}>
              <div className="row-between wrap" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
                <h2 style={{ fontSize: 18 }}>{t('product.liveTraffic')}</h2>
                <span className="badge badge-neutral tiny">{t('product.liveAdvisory')}</span>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                {product.live.summary}
              </p>
              <ul
                className="row wrap tiny muted"
                style={{ gap: 'var(--sp-3)', listStyle: 'none', margin: 'var(--sp-3) 0 0', padding: 0 }}
              >
                {product.live.flights.slice(0, 4).map((flight) => (
                  <li key={flight.icao24}>
                    <span className="bold">{flight.callsign}</span>
                    {flight.aircraftType ? ` · ${flight.aircraftType}` : ''}
                    {flight.altitudeFt !== null ? ` · ${Math.round(flight.altitudeFt / 100) * 100} ft` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Calendar */}
          <section className="card card-pad stack">
            <div className="row-between">
              <h2 style={{ fontSize: 18 }}>{t('product.pickDate')}</h2>
              {selectedDate && (
                <a href={`/products/${slug}`} className="tiny" style={{ color: 'var(--brand-600)', fontWeight: 600 }}>
                  {t('product.clearDate')}
                </a>
              )}
            </div>
            {availability.days.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                {t('product.noAvailability')}
              </p>
            ) : (
              <AvailabilityCalendar
                slug={slug}
                days={availability.days}
                selected={activeDate}
                locale={locale}
              />
            )}
          </section>

          {/* Meeting point */}
          {product.meetingPoint && (
            <section className="card card-pad stack">
              <h2 style={{ fontSize: 18 }}>{t('product.meetingPoint')}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {product.meetingPoint}
              </p>
              {product.location.addressLine && (
                <p className="small subtle" style={{ margin: 0 }}>
                  {product.location.addressLine}
                </p>
              )}
              {product.flags.wheelchairAccessible && (
                <span className="badge badge-positive">{t('product.wheelchairAccessible')}</span>
              )}
            </section>
          )}

          {/* What's included */}
          <section className="card card-pad">
            <div className="grid grid-2" style={{ gap: 'var(--sp-5)' }}>
              <div className="stack-sm">
                <h3 style={{ fontSize: 16 }}>{t('product.included')}</h3>
                <ul style={{ margin: 0, paddingLeft: 18 }} className="small stack-sm">
                  {product.includes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="stack-sm">
                <h3 style={{ fontSize: 16 }}>{t('product.excluded')}</h3>
                <ul style={{ margin: 0, paddingLeft: 18 }} className="small stack-sm">
                  {product.excludes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* Cancellation policy */}
          {product.cancellationPolicy && (
            <section className="card card-pad stack">
              <h2 style={{ fontSize: 18 }}>{t('product.cancellationPolicy')}</h2>
              {product.cancellationPolicy.description && (
                <p className="muted" style={{ margin: 0 }}>
                  {product.cancellationPolicy.description}
                </p>
              )}
              <RefundTable tiers={product.cancellationPolicy.tiers} locale={locale} />
            </section>
          )}

          {/* Important info */}
          <section className="card card-pad stack">
            <h2 style={{ fontSize: 18 }}>{t('product.goodToKnow')}</h2>
            <div className="grid grid-2" style={{ gap: 'var(--sp-3)' }}>
              {product.flags.durationMinutes && (
                <InfoRow
                  label={t('product.duration')}
                  value={t('product.hoursCount', Math.round((product.flags.durationMinutes / 60) * 10) / 10)}
                />
              )}
              {product.flags.languages.length > 0 && (
                <InfoRow label={t('product.languages')} value={product.flags.languages.join(', ')} />
              )}
              {product.flags.minAge !== null && (
                <InfoRow label={t('product.minimumAge')} value={t('product.years', product.flags.minAge)} />
              )}
              {product.merchant && <InfoRow label={t('product.operatedBy')} value={product.merchant.name} />}
              {product.destination?.countryCode && (
                <InfoRow label={t('product.country')} value={product.destination.countryCode} />
              )}
            </div>
          </section>

          {/* Reviews */}
          <div id="reviews">
            <ReviewSection
              slug={product.slug}
              reviews={product.reviews}
              rating={product.rating}
              locale={locale}
            />
          </div>

          {/* Similar */}
          {product.similar.length > 0 && (
            <section className="stack">
              <h2 style={{ fontSize: 18 }}>{t('product.similar')}</h2>
              <div className="stack">
                {product.similar.slice(0, 4).map((item) => (
                  <a
                    key={item.productId}
                    href={`/products/${item.slug}`}
                    className="card card-hover row"
                    style={{ padding: 'var(--sp-3)', gap: 'var(--sp-3)' }}
                  >
                    {item.imageUrl && (
                      <img
                        src={item.imageUrl}
                        alt=""
                        style={{ width: 68, height: 68, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                        loading="lazy"
                      />
                    )}
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="bold small truncate">{item.title}</div>
                      <div className="tiny subtle">
                        {item.ratingCount > 0
                          ? `★ ${item.ratingAvg.toFixed(1)} (${item.ratingCount})`
                          : t('product.newListing')}
                      </div>
                    </div>
                    <div className="bold nowrap">{formatMoney(item.priceCents, item.currency)}</div>
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Sticky booking panel                                            */}
        {/* ---------------------------------------------------------------- */}
        <div className="with-rail-side with-rail-side-wide booking-panel-col">
          <BookingPanel
            product={product}
            selectedDate={activeDate}
            quantity={quantity}
            lowestPrice={cheapest === Number.MAX_SAFE_INTEGER ? null : cheapest}
            locale={locale}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Gallery({
  media,
  name,
  morePhotosLabel,
}: {
  media: ProductDetail['media'];
  name: string;
  morePhotosLabel: string;
}) {
  const [hero, ...rest] = media;

  if (!hero) {
    return (
      <div className="card" style={{ height: 380, display: 'grid', placeItems: 'center', fontSize: 40 }}>
        🖼
      </div>
    );
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 'var(--sp-3)' }}>
      <div style={{ position: 'relative', borderRadius: 'var(--r-lg)', overflow: 'hidden', minHeight: 380 }}>
        <SafeImage
          src={hero.url}
          alt={hero.altText ?? name}
          loading="eager"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fallback={<div className="img-fallback" aria-hidden>✦</div>}
        />
      </div>

      <div className="grid" style={{ gap: 'var(--sp-3)', gridTemplateRows: '1fr 1fr' }}>
        {rest.slice(0, 2).map((image) => (
          <div key={image.url} style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
            <SafeImage
              src={image.url}
              alt={image.altText ?? name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fallback={<div className="img-fallback" aria-hidden>✦</div>}
            />
          </div>
        ))}
        {rest.length < 2 && (
          <div
            className="card"
            style={{ display: 'grid', placeItems: 'center', color: 'var(--text-muted)', minHeight: 180 }}
          >
            {morePhotosLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small" style={{ gap: 'var(--sp-3)' }}>
      <span className="muted">{label}</span>
      <span className="bold right">{value}</span>
    </div>
  );
}

/** Renders the tiered refund table from the cancellation policy. */
function RefundTable({
  tiers,
  locale,
}: {
  tiers: { minHoursBefore: number; refundBps: number }[];
  locale: LocaleCode;
}) {
  if (!tiers || tiers.length === 0) return null;

  const t = createTranslator(locale);

  const sorted = [...tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  const ordered = [...sorted].reverse();

  return (
    <div className="stack-sm">
      {ordered.map((tier, index) => {
        const next = ordered[index + 1];
        const label =
          tier.minHoursBefore === 0
            ? t('product.lessThan24h')
            : next
              ? t(
                  'product.beforeRange',
                  formatNotice(tier.minHoursBefore, t),
                  formatNotice(next.minHoursBefore, t),
                )
              : t('product.moreThanBefore', formatNotice(tier.minHoursBefore, t));

        return (
          <div key={tier.minHoursBefore} className="row-between small" style={{ gap: 'var(--sp-3)' }}>
            <span className="muted">{label}</span>
            <span className="bold nowrap">{t('product.refundPercent', Math.round(tier.refundBps / 100))}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatNotice(hours: number, t: (key: string, ...args: unknown[]) => string): string {
  if (hours >= 72 && hours % 24 === 0 && hours >= 48) return t('product.daysCount', hours / 24);
  if (hours >= 24) return t('product.hoursCount', hours);
  return t('product.hoursShort', hours);
}