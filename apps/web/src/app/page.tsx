import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { ProductCard } from '@/components/ProductCard';
import { PromoStrip } from '@/components/PromoStrip';
import { SafeImage } from '@/components/SafeImage';
import { resolveServerLocale, htmlLang } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import { brandName, brandTagline } from '@/lib/brand';
import type { LocaleCode } from '@/lib/i18n/config';

// Destination rails and curated collections change slowly; revalidate hourly.
// Shorter than the promotions strip, which operators edit far more often.
export const revalidate = 300;

const TRUST_POINTS = ['home.instantConfirm', 'home.freeCancel', 'home.skipTheLine'] as const;

export default async function HomePage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  // Every rail is independent: one failing call must not blank the page.
  const [destinations, trending, freeCancel, skipLine, topRated] = await Promise.all([
    api.destinations().catch(() => []),
    api.collection('trending', null, locale).catch(() => null),
    api.collection('free-cancellation', null, locale).catch(() => null),
    api.collection('skip-the-line', null, locale).catch(() => null),
    api.collection('top-rated', null, locale).catch(() => null),
  ]);

  /**
   * No product is shown twice on the home page.
   *
   * The four rails are independent queries — `trending` sorts by popularity,
   * `top-rated` by rating, and the other two by nothing in particular — so they
   * overlap freely. One product came first in all four, which put its
   * photograph on the page four times and made a merchandised home page read as
   * a template loop. The rails are ordered deliberately, so the first rail that
   * claims a product keeps it and later rails skip it.
   *
   * `take` is applied here rather than left to the rail's own `slice`, so a
   * product that will not actually be displayed is not reserved against the
   * rails below it — otherwise one rail's hidden surplus could empty the next.
   */
  const shown = new Set<string>();
  const claim = <T extends { productId: string }>(items: T[], take: number): T[] => {
    const out: T[] = [];
    for (const item of items) {
      if (out.length >= take) break;
      if (shown.has(item.productId)) continue;
      shown.add(item.productId);
      out.push(item);
    }
    return out;
  };

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* Hero + search                                                  */}
      {/* ---------------------------------------------------------------- */}
      <section
        className="hero-premium"
        style={{
          background: 'linear-gradient(135deg, var(--brand-900) 0%, var(--brand-700) 48%, var(--brand-500) 100%)',
          color: '#fff',
          padding: 'var(--sp-8) 0 var(--sp-8)',
        }}
      >
        <div className="container">
          <div className="stack" style={{ maxWidth: 760 }}>
            {/* The brand promise line sits above the headline so the first thing
                a visitor reads is who this is, not what it sells. */}
            <p className="hero-kicker">
              <span className="hero-kicker-mark" aria-hidden>
                {brandName(locale)}
              </span>
              <span>{brandTagline(locale)}</span>
            </p>
            <h1 className="hero-title">{t('home.heroTitle')}</h1>
            <p className="hero-subtitle">{t('home.heroSubtitle')}</p>
          </div>

          <SearchBox locale={locale} />

          <div className="row wrap" style={{ gap: 'var(--sp-5)', marginTop: 'var(--sp-6)' }}>
            {TRUST_POINTS.map((key) => (
              <span key={key} className="hero-trust">
                <span aria-hidden>✓</span>
                {t(key)}
              </span>
            ))}
          </div>
        </div>
      </section>

      <div className="container">
        {/* -------------------------------------------------------------- */}
        {/* Operator-authored promotions                                   */}
        {/* -------------------------------------------------------------- */}
        <PromoStrip locale={locale} />

        {/* -------------------------------------------------------------- */}
        {/* Destination grid                                              */}
        {/* -------------------------------------------------------------- */}
        {destinations.length > 0 && (
          <section style={{ padding: 'var(--sp-4) 0 var(--sp-7)' }}>
            <div className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
              <div>
                <h2>{t('home.destinations')}</h2>
                <p className="small muted" style={{ margin: 0 }}>
                  {t('home.destinationsSubtitle')}
                </p>
              </div>
              <Link href="/search" className="btn btn-ghost btn-sm">
                {t('common.seeAll')} →
              </Link>
            </div>

            <div className="grid grid-4">
              {destinations.slice(0, 8).map((destination) => (
                <Link
                  key={destination.slug}
                  href={`/search?destination=${destination.slug}`}
                  className="destination-tile"
                >
                  <div className="destination-media">
                    <SafeImage
                      src={destination.heroImageUrl}
                      alt={destination.name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      fallback={
                        // No image (or it failed): the tile keeps a dark base so
                        // the white caption stays legible instead of sitting on grey.
                        <div className="destination-fallback" aria-hidden>
                          <span>{destination.name.slice(0, 1)}</span>
                        </div>
                      }
                    />
                    <div className="destination-scrim" />
                    <div className="destination-caption">
                      <div className="destination-name">{destination.name}</div>
                      <div className="destination-count">{t('home.experiencesCount', destination.productCount)}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* -------------------------------------------------------------- */}
        {/* Trending                                                      */}
        {/* -------------------------------------------------------------- */}
        {trending && trending.items.length > 0 && (
          <Rail
            title={trending.title}
            subtitle={t('home.trendingSubtitle')}
            hits={claim(trending.items, 5)}
            locale={locale}
          />
        )}

        {/* -------------------------------------------------------------- */}
        {/* Promo split: free cancellation + skip the line                */}
        {/* -------------------------------------------------------------- */}
        <section style={{ paddingBottom: 'var(--sp-7)' }}>
          <div className="grid grid-2">
            {freeCancel && (
              <CollectionCard
                title={t('home.freeCancel')}
                subtitle={t('home.freeCancelSubtitle')}
                href="/collections/free-cancellation"
                hits={claim(freeCancel.items, 3)}
                tone="success"
                locale={locale}
              />
            )}
            {skipLine && (
              <CollectionCard
                title={t('home.skipTheLine')}
                subtitle={t('home.skipLineSubtitle')}
                href="/collections/skip-the-line"
                hits={claim(skipLine.items, 3)}
                tone="brand"
                locale={locale}
              />
            )}
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Top rated                                                     */}
        {/* -------------------------------------------------------------- */}
        {topRated && topRated.items.length > 0 && (
          <Rail
            title={t('home.favourites')}
            subtitle={t('home.favouritesSubtitle')}
            hits={claim(topRated.items, 5)}
            locale={locale}
          />
        )}

        {/* -------------------------------------------------------------- */}
        {/* Loyalty pitch                                                 */}
        {/* -------------------------------------------------------------- */}
        <section style={{ padding: 'var(--sp-7) 0' }}>
          <div
            className="card card-pad loyalty-panel"
            style={{ padding: 'var(--sp-6)' }}
          >
            <div className="row-between wrap" style={{ gap: 'var(--sp-5)' }}>
              <div className="stack-sm" style={{ maxWidth: 480 }}>
                <span className="badge badge-brand">{t('home.rewardsBadge')}</span>
                <h2>{t('home.rewardsTitle')}</h2>
                <p className="muted">{t('home.rewardsBody')}</p>
              </div>
              <Link href="/loyalty" className="btn btn-primary btn-lg">
                {t('home.joinProgramme')}
              </Link>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function SearchBox({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);

  return (
    <form
      action="/search"
      method="get"
      className="card hero-search"
    >
      <div className="hero-field">
        <label htmlFor="q" className="hero-label">
          {t('home.whatToDo')}
        </label>
        <input
          id="q"
          name="q"
          className="input"
          placeholder={
            locale === 'zh'
              ? '国际机票、五星酒店、邮轮、私人向导…'
              : 'International flights, five-star hotels, cruises, private guides…'
          }
          style={{ border: 'none', padding: '4px 0', fontSize: 16 }}
        />
      </div>

      <div className="hero-field">
        <label htmlFor="destination" className="hero-label">
          {t('home.where')}
        </label>
        <input
          id="destination"
          name="destination"
          className="input"
          placeholder={locale === 'zh' ? '城市或国家' : 'City or country'}
          style={{ border: 'none', padding: '4px 0', fontSize: 16 }}
        />
      </div>

      <div className="hero-field">
        <label htmlFor="date" className="hero-label">
          {t('home.when')}
        </label>
        <input
          id="date"
          name="date"
          type="date"
          className="input"
          // Without this the native control renders its format placeholder in
          // the *browser's* locale, so an English page shows `年月日`.
          lang={htmlLang(locale)}
          style={{ border: 'none', padding: '4px 0', fontSize: 16 }}
        />
      </div>

      <button type="submit" className="btn btn-accent btn-lg hero-submit" style={{ height: 48 }}>
        {t('common.search')}
      </button>
    </form>
  );
}

function Rail({
  title,
  subtitle,
  hits,
  locale,
}: {
  title: string;
  subtitle?: string;
  hits: Parameters<typeof ProductCard>[0]['hit'][];
  locale: LocaleCode;
}) {
  return (
    <section style={{ paddingBottom: 'var(--sp-7)' }}>
      <div className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
        <div>
          <h2>{title}</h2>
          {subtitle && (
            <p className="small muted" style={{ margin: 0 }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div className="stack">
        {hits.slice(0, 5).map((hit) => (
          <ProductCard key={hit.productId} hit={hit} locale={locale} />
        ))}
      </div>
    </section>
  );
}

function CollectionCard({
  title,
  subtitle,
  href,
  hits,
  tone,
  locale,
}: {
  title: string;
  subtitle: string;
  href: string;
  hits: Parameters<typeof ProductCard>[0]['hit'][];
  tone: 'brand' | 'success';
  locale: LocaleCode;
}) {
  return (
    <div
      className="card"
      style={{
        padding: 'var(--sp-5)',
        background: tone === 'success' ? 'var(--success-50)' : 'var(--brand-50)',
        borderColor: tone === 'success' ? 'var(--success-600)' : 'var(--brand-100)',
      }}
    >
      <div className="row-between" style={{ marginBottom: 'var(--sp-4)' }}>
        <div>
          <h3>{title}</h3>
          <p className="small muted" style={{ margin: 0 }}>
            {subtitle}
          </p>
        </div>
        <Link href={href} className="btn btn-secondary btn-sm">
          Browse
        </Link>
      </div>

      <div className="stack-sm">
        {hits.map((hit) => (
          <Link
            key={hit.productId}
            href={`/products/${hit.slug}`}
            className="row"
            style={{
              padding: 'var(--sp-2)',
              background: 'var(--surface)',
              borderRadius: 'var(--r-md)',
              border: '1px solid var(--border)',
              gap: 'var(--sp-3)',
            }}
          >
            {hit.imageUrl && (
              <SafeImage
                src={hit.imageUrl}
                alt=""
                style={{ width: 46, height: 46, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                fallback={<div className="img-fallback img-fallback-sm" aria-hidden />}
              />
            )}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small bold truncate">{hit.title}</div>
              <div className="tiny subtle">
                {hit.ratingCount > 0 ? `★ ${hit.ratingAvg.toFixed(1)} (${hit.ratingCount})` : 'New listing'}
              </div>
            </div>
            <div className="bold nowrap">{formatMoney(hit.priceCents, hit.currency)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}