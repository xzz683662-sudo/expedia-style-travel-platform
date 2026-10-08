import type { Metadata } from 'next';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { ProductCard } from '@/components/ProductCard';
import { EmptyState } from '@/components/PageShell';
import { FilterRail } from '@/components/FilterRail';
import { resolveServerLocale, htmlLang } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import type { LocaleCode } from '@/lib/i18n/config';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return {
    title: locale === 'zh' ? '搜索全球行程' : 'Search global journeys',
    description: t('search.metaDescription'),
  };
}

type SearchPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Sort values are stable; the label is resolved per locale at render time. */
const SORT_OPTIONS = [
  { value: 'RELEVANCE', key: 'search.sortRelevance' },
  { value: 'PRICE_ASC', key: 'search.sortPriceAsc' },
  { value: 'PRICE_DESC', key: 'search.sortPriceDesc' },
  { value: 'RATING', key: 'search.sortRating' },
  { value: 'POPULARITY', key: 'search.sortPopularity' },
] as const;

/** Category rails are capped so a nine-category catalogue stays scannable. */
const RAIL_SIZE = 4;
const MAX_RAILS = 8;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

/**
 * Query params can repeat (`?types=A&types=B` when the facet checkboxes are
 * submitted) and can also arrive as one CSV value from a tab link. Both shapes
 * collapse to a single CSV string here so the API sees one canonical form.
 */
function csvParam(value: string | string[] | undefined): string | undefined {
  const parts = (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(',') : undefined;
}

function typeList(value: string | number | undefined): string[] {
  return value ? String(value).split(',').filter(Boolean) : [];
}

/**
 * Filters arrive as strings from the query string, but a few are normalised
 * before use (page is a number, flags are booleans). One shared alias keeps the
 * chip links, the sidebar form and the API call reading the same values.
 */
type ActiveFilters = Record<string, string | number | undefined> & { page: number };

/** Filter keys that represent an actual narrowing, not just navigation state. */
const FILTER_KEYS = [
  'type',
  'types',
  'minPrice',
  'maxPrice',
  'minRating',
  'instantConfirm',
  'freeCancellation',
  'skipTheLine',
  'date',
] as const;

function countActiveFilters(active: ActiveFilters): number {
  return FILTER_KEYS.filter((key) => active[key] !== undefined && active[key] !== '').length;
}

/** Serialises the active filters into a query string for a link. */
function toQueryString(active: ActiveFilters, overrides: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(active)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page') continue;
    merged[key] = String(value);
  }
  // `types` is the canonical multi-category form; the legacy singular `type`
  // would otherwise fight with it and the API would ignore one of them.
  if (merged.types) delete merged.type;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === '') delete merged[key];
    else merged[key] = value;
  }

  const params = new URLSearchParams(merged);
  return params.toString();
}

function searchHref(active: ActiveFilters, overrides: Record<string, string | undefined> = {}): string {
  const query = toQueryString(active, overrides);
  return query ? `/search?${query}` : '/search';
}

/** Carries every active filter through a form that only edits a few of them. */
function HiddenFilters({ active, omit }: { active: ActiveFilters; omit: readonly string[] }) {
  return (
    <>
      {Object.entries(active).map(([key, value]) => {
        if (omit.includes(key) || value === undefined || value === null || value === '') return null;
        if (key === 'page' && omit.includes('page')) return null;
        return <input key={key} type="hidden" name={key} value={String(value)} />;
      })}
    </>
  );
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  const query: ActiveFilters = {
    q: first(params.q),
    destination: first(params.destination),
    // `types` is the unified multi-category filter; `type` is the legacy single
    // value still emitted by older links and the collection pages.
    types: csvParam(params.types) ?? csvParam(params.type),
    date: first(params.date),
    minPrice: first(params.minPrice),
    maxPrice: first(params.maxPrice),
    minRating: first(params.minRating),
    instantConfirm: first(params.instantConfirm),
    freeCancellation: first(params.freeCancellation),
    skipTheLine: first(params.skipTheLine),
    sort: first(params.sort),
    view: first(params.view),
    page: Number(first(params.page) ?? 1),
  };

  const selectedTypes = typeList(query.types);
  const categoryFiltered = selectedTypes.length > 0;
  // Grouped rails are the default discovery experience; the flat, paginated
  // list takes over as soon as the shopper narrows to a category (or asks for it).
  const grouped = !categoryFiltered && query.view !== 'list';

  const result = await api
    .search({
      q: query.q,
      destination: query.destination,
      types: query.types,
      date: query.date,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      minRating: query.minRating,
      instantConfirm: query.instantConfirm,
      freeCancellation: query.freeCancellation,
      skipTheLine: query.skipTheLine,
      sort: query.sort,
      page: grouped ? 1 : query.page,
      pageSize: grouped ? 12 : 20,
    }, null, locale)
    .catch(() => null);

  if (!result) {
    return (
      <div className="container" style={{ padding: 'var(--sp-8) 0' }}>
        <EmptyState
          title={t('search.unavailable')}
          description={t('search.unavailableHint')}
          action={{ label: t('search.backHome'), href: '/' }}
        />
      </div>
    );
  }

  const heading = query.destination
    ? t('search.headingDestination', String(query.destination))
    : query.q
      ? t('search.headingQuery', String(query.q))
      : t('search.headingAll');

  // Category rails come from the same response as `items` — no extra requests,
  // and the counts can never disagree with the list.
  const rails = grouped ? result.groups.filter((group) => group.items.length > 0).slice(0, MAX_RAILS) : [];

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-5)', paddingBottom: 'var(--sp-7)' }}>
      {/* ------------------------------------------------------------------ */}
      {/* Unified search panel                                               */}
      {/* ------------------------------------------------------------------ */}
      {/* One query box spanning every category, instead of a per-category      */}
      {/* entry point. The category tabs below decide *what* is being searched, */}
      {/* this panel decides *what for* and *where*.                            */}
      <UnifiedSearchPanel active={query} locale={locale} />

      {/* ------------------------------------------------------------------ */}
      {/* Header + summary                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="row-between wrap" style={{ marginBottom: 'var(--sp-4)', marginTop: 'var(--sp-5)' }}>
        <div>
          <h1 style={{ fontSize: 26 }} className="capitalize">
            {heading}
          </h1>
          <p className="small muted" style={{ margin: 0 }}>
            {t('search.found', result.total)}
            {query.date && ` · ${query.date}`}
          </p>
        </div>

        <form method="get" className="row" style={{ gap: 'var(--sp-2)' }}>
          {/* Preserve active filters when the shopper changes sort. */}
          <HiddenFilters active={query} omit={['sort', 'page']} />

          <label htmlFor="sort" className="small muted nowrap">
            {t('search.sortLabel')}
          </label>
          <select id="sort" name="sort" className="select" defaultValue={query.sort ?? 'RELEVANCE'} style={{ width: 'auto' }}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.key)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary btn-sm">
            {t('search.apply')}
          </button>
        </form>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Category tabs — the multi-category axis of the search              */}
      {/* ------------------------------------------------------------------ */}
      <CategoryTabs active={query} facets={result.facets} locale={locale} />

      {/* ------------------------------------------------------------------ */}
      {/* Quick filter chips                                                 */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ marginTop: 'var(--sp-3)' }}>
        <FilterChips active={query} locale={locale} />
      </div>

      <div className="with-rail" style={{ marginTop: 'var(--sp-4)' }}>
        {/* ---------------------------------------------------------------- */}
        {/* Filter sidebar                                                   */}
        {/* ---------------------------------------------------------------- */}
        <FilterRail activeCount={countActiveFilters(query)} locale={locale}>
          <FilterPanel facets={result.facets} active={query} locale={locale} />
        </FilterRail>

        {/* ---------------------------------------------------------------- */}
        {/* Results                                                          */}
        {/* ---------------------------------------------------------------- */}
        <div className="with-rail-main stack">
          {result.total === 0 ? (
            <EmptyState
              title={t('search.empty')}
              description={t('search.emptyHint')}
              action={{ label: t('search.clearFilters'), href: '/search' }}
            />
          ) : grouped && rails.length > 0 ? (
            <CategoryRails rails={rails} active={query} total={result.total} locale={locale} />
          ) : result.items.length === 0 ? (
            <EmptyState
              title={t('search.empty')}
              description={t('search.emptyHint')}
              action={{ label: t('search.clearFilters'), href: '/search' }}
            />
          ) : (
            <>
              {query.view === 'list' && (
                <Link href={searchHref(query, { view: undefined, page: undefined })} className="small" style={{ color: 'var(--brand-600)', fontWeight: 600 }}>
                  ← {t('search.groupByCategory')}
                </Link>
              )}

              {result.items.map((hit) => (
                <ProductCard key={hit.productId} hit={hit} locale={locale} />
              ))}

              {result.totalPages > 1 && <Pagination result={result} params={query} locale={locale} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Unified search panel.
 *
 * Deliberately type-agnostic: the shopper types a free-text query and a place,
 * and the platform decides which categories answer it. That is what makes the
 * search a cross-category discovery surface rather than a category filter box.
 */
function UnifiedSearchPanel({ active, locale }: { active: ActiveFilters; locale: LocaleCode }) {
  const t = createTranslator(locale);

  return (
    <form
      method="get"
      className="card card-pad unified-search"
    >
      {/* Keep the current narrowing (price, rating, flags) while re-searching. */}
      <HiddenFilters active={active} omit={['q', 'destination', 'date', 'page', 'types', 'view']} />

      <label className="field">
        <span className="label">{t('search.what')}</span>
        <input className="input" type="search" name="q" defaultValue={active.q ? String(active.q) : ''} placeholder={t('search.whatPlaceholder')} />
      </label>

      <label className="field">
        <span className="label">{t('search.where')}</span>
        <input className="input" name="destination" defaultValue={active.destination ? String(active.destination) : ''} placeholder={t('search.wherePlaceholder')} />
      </label>

      <label className="field">
        <span className="label">{t('search.when')}</span>
        <input
          className="input"
          type="date"
          name="date"
          // See `htmlLang`: a date input formats itself in the browser's locale.
          lang={htmlLang(locale)}
          defaultValue={active.date ? String(active.date) : ''}
        />
      </label>

      <button type="submit" className="btn btn-primary">
        {t('search.searchButton')}
      </button>
    </form>
  );
}

/**
 * Category tab bar.
 *
 * Counts come from the API's *disjunctive* type facet, so every tab keeps its
 * real count even while a different category is selected — the tabs are a
 * widening control, not a dead end.
 */
function CategoryTabs({
  active,
  facets,
  locale,
}: {
  active: ActiveFilters;
  facets: Awaited<ReturnType<typeof api.search>>['facets'];
  locale: LocaleCode;
}) {
  const t = createTranslator(locale);
  const selected = typeList(active.types);

  const tab = (label: string, value: string | undefined, count: number, isActive: boolean) => (
    <Link
      key={value ?? 'all'}
      href={searchHref(active, { types: isActive ? undefined : value, page: undefined })}
      className={`badge ${isActive ? 'badge-brand' : 'badge-neutral'}`}
      style={{ padding: '8px 14px', fontSize: 13.5, whiteSpace: 'nowrap' }}
      aria-current={isActive ? 'true' : undefined}
    >
      {label}
      <span className="tiny" style={{ opacity: 0.75, marginLeft: 6 }}>
        {count}
      </span>
    </Link>
  );

  const totalCount = facets.types.reduce((sum, type) => sum + type.count, 0);

  return (
    <nav className="row wrap" style={{ gap: 'var(--sp-2)', alignItems: 'center' }} aria-label={t('search.category')}>
      <span className="small muted nowrap" style={{ fontWeight: 600 }}>
        {t('search.browseBy')}
      </span>
      {tab(t('search.allCategories'), undefined, totalCount, selected.length === 0)}
      {facets.types.map((type) => tab(type.label, type.value, type.count, selected.length === 1 && selected[0] === type.value))}
    </nav>
  );
}

/**
 * Grouped discovery flow: one rail per category, all drawn from the single
 * unified search response. Rendering rails *and* a full flat list would repeat
 * the same cards, so the grouped view offers an explicit "view all" hand-off to
 * the paginated list instead.
 */
function CategoryRails({
  rails,
  active,
  total,
  locale,
}: {
  rails: Awaited<ReturnType<typeof api.search>>['groups'];
  active: ActiveFilters;
  total: number;
  locale: LocaleCode;
}) {
  const t = createTranslator(locale);

  return (
    <>
      {rails.map((rail) => (
        <section key={rail.type} className="stack" style={{ gap: 'var(--sp-3)' }}>
          <div className="row-between wrap" style={{ gap: 'var(--sp-2)' }}>
            <div>
              <h2 style={{ fontSize: 19, margin: 0 }}>{rail.label}</h2>
              <p className="tiny subtle" style={{ margin: 0 }}>
                {t('search.railCount', rail.count)}
              </p>
            </div>
            <Link
              href={searchHref(active, { types: rail.type, page: undefined })}
              className="small nowrap"
              style={{ color: 'var(--brand-600)', fontWeight: 600 }}
            >
              {t('search.seeAllIn', rail.label)} →
            </Link>
          </div>

          <div className="stack" style={{ gap: 'var(--sp-3)' }}>
            {rail.items.slice(0, RAIL_SIZE).map((hit) => (
              <ProductCard key={hit.productId} hit={hit} locale={locale} />
            ))}
          </div>

          <hr className="divider" />
        </section>
      ))}

      <div className="row" style={{ justifyContent: 'center', paddingBottom: 'var(--sp-4)' }}>
        <Link href={searchHref(active, { view: 'list', page: undefined })} className="btn btn-secondary">
          {t('search.viewAllResults', total)}
        </Link>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function FilterChips({ active, locale }: { active: ActiveFilters; locale: LocaleCode }) {
  const t = createTranslator(locale);

  // Toggling a chip resets pagination but keeps the category selection, the
  // query and every other narrowing intact.
  const chips: { label: string; active: boolean; href: string }[] = [
    {
      label: t('search.freeCancellation'),
      active: Boolean(active.freeCancellation),
      href: searchHref(active, {
        freeCancellation: active.freeCancellation ? undefined : 'true',
        page: undefined,
      }),
    },
    {
      label: t('search.skipTheLine'),
      active: Boolean(active.skipTheLine),
      href: searchHref(active, { skipTheLine: active.skipTheLine ? undefined : 'true', page: undefined }),
    },
    {
      label: t('search.instantConfirm'),
      active: Boolean(active.instantConfirm),
      href: searchHref(active, { instantConfirm: active.instantConfirm ? undefined : 'true', page: undefined }),
    },
    {
      label: t('search.topRatedChip'),
      active: active.minRating === '4.5',
      href: searchHref(active, { minRating: active.minRating === '4.5' ? undefined : '4.5', page: undefined }),
    },
  ];

  return (
    <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          className={`badge ${chip.active ? 'badge-brand' : 'badge-neutral'}`}
          style={{ padding: '7px 13px', fontSize: 13 }}
        >
          {chip.active && '✓ '}
          {chip.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Facet rail for the unified search.
 *
 * The category facet is *multi-select* (Angular-style `types=A,B`) rather than a
 * radio group: a shopper looking for "something to do tonight" wants attractions
 * and tours and cruises in one result set, which is exactly the multi-category
 * query the API accepts.
 */
function FilterPanel({
  facets,
  active,
  locale,
}: {
  facets: Awaited<ReturnType<typeof api.search>>['facets'];
  active: ActiveFilters;
  locale: LocaleCode;
}) {
  const t = createTranslator(locale);
  const selectedTypes = typeList(active.types);
  const hasFilters =
    selectedTypes.length > 0 ||
    active.minPrice ||
    active.maxPrice ||
    active.minRating ||
    active.freeCancellation ||
    active.skipTheLine;

  return (
    <form method="get" className="stack" style={{ gap: 'var(--sp-5)' }}>
      {/* Categories are multi-select, so the form must not also re-send a single
          `type`; `query` only carries `types` after normalisation. */}
      <HiddenFilters active={active} omit={['type', 'types', 'sort', 'page']} />
      {active.sort && <input type="hidden" name="sort" value={String(active.sort)} />}

      <div className="card card-pad stack" style={{ gap: 'var(--sp-4)' }}>
        <div className="row-between">
          <h3 style={{ fontSize: 15 }}>{t('search.filters')}</h3>
          {hasFilters && (
            <Link href="/search" className="tiny" style={{ color: 'var(--brand-600)', fontWeight: 600 }}>
              {t('search.clearAll')}
            </Link>
          )}
        </div>

        {/* Category */}
        {facets.types.length > 0 && (
          <div className="field">
            <span className="label">{t('search.category')}</span>
            <div className="stack-sm">
              {facets.types.slice(0, 8).map((type) => (
                <label key={type.value} className="checkbox-row small">
                  <input type="checkbox" name="types" value={type.value} defaultChecked={selectedTypes.includes(type.value)} />
                  <span className="grow">{type.label}</span>
                  <span className="tiny subtle">{type.count}</span>
                </label>
              ))}
              {selectedTypes.length > 1 && (
                <span className="tiny subtle">{t('search.multipleCategoriesSelected', selectedTypes.length)}</span>
              )}
            </div>
          </div>
        )}

        {/* Price */}
        <div className="field">
          <span className="label">{t('search.pricePerPerson')}</span>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <input
              className="input"
              type="number"
              name="minPrice"
              placeholder={t('search.min')}
              defaultValue={active.minPrice ? String(active.minPrice) : ''}
              style={{ padding: '8px 10px' }}
            />
            <span className="subtle">–</span>
            <input
              className="input"
              type="number"
              name="maxPrice"
              placeholder={t('search.max')}
              defaultValue={active.maxPrice ? String(active.maxPrice) : ''}
              style={{ padding: '8px 10px' }}
            />
          </div>
          {facets.priceRange.maxCents > 0 && (
            <span className="tiny subtle">
              {t(
                'search.availableFrom',
                formatMoney(facets.priceRange.minCents),
                formatMoney(facets.priceRange.maxCents),
              )}
            </span>
          )}
        </div>

        {/* Rating */}
        <div className="field">
          <span className="label">{t('search.rating')}</span>
          <div className="stack-sm">
            <label className="checkbox-row small">
              <input type="radio" name="minRating" value="" defaultChecked={!active.minRating} />
              {t('search.anyRating')}
            </label>
            {[4.5, 4, 3.5].map((rating) => (
              <label key={rating} className="checkbox-row small">
                <input type="radio" name="minRating" value={rating} defaultChecked={active.minRating === String(rating)} />
                <span className="rating-stars" aria-hidden>
                  {'★'.repeat(Math.floor(rating))}
                </span>
                <span>{t('search.ratingAndUp', rating)}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Convenience */}
        <div className="field">
          <span className="label">{t('search.bookingOptions')}</span>
          <div className="stack-sm">
            <label className="checkbox-row small">
              <input type="checkbox" name="freeCancellation" value="true" defaultChecked={Boolean(active.freeCancellation)} />
              {t('search.freeCancellation')}
            </label>
            <label className="checkbox-row small">
              <input type="checkbox" name="skipTheLine" value="true" defaultChecked={Boolean(active.skipTheLine)} />
              {t('search.skipTheLine')}
            </label>
            <label className="checkbox-row small">
              <input type="checkbox" name="instantConfirm" value="true" defaultChecked={Boolean(active.instantConfirm)} />
              {t('search.instantConfirm')}
            </label>
          </div>
        </div>

        <button type="submit" className="btn btn-primary btn-block">
          {t('search.applyFilters')}
        </button>
      </div>

      {/* Top destinations */}
      {facets.destinations.length > 0 && (
        <div className="card card-pad stack" style={{ gap: 'var(--sp-2)' }}>
          <h3 style={{ fontSize: 14 }}>{t('search.topDestinations')}</h3>
          <div className="stack-sm">
            {facets.destinations.slice(0, 8).map((destination) => (
              <Link
                key={destination.value}
                href={`/search?destination=${encodeURIComponent(destination.value)}`}
                className="row-between small"
                style={{ color: 'var(--text-muted)' }}
              >
                <span className="truncate">{destination.label}</span>
                <span className="tiny subtle">{destination.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}

function Pagination({
  result,
  params,
  locale,
}: {
  result: Awaited<ReturnType<typeof api.search>>;
  params: Record<string, unknown>;
  locale: LocaleCode;
}) {
  const href = (page: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '' || key === 'page') continue;
      search.set(key, String(value));
    }
    if (page > 1) search.set('page', String(page));
    const query = search.toString();
    return query ? `/search?${query}` : '/search';
  };

  const t = createTranslator(locale);

  // Window the page numbers so the pager stays readable on long result sets.
  const pages: number[] = [];
  const start = Math.max(1, result.page - 2);
  const end = Math.min(result.totalPages, start + 4);
  for (let page = start; page <= end; page += 1) pages.push(page);

  return (
    <nav className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'center', paddingTop: 'var(--sp-4)' }}>
      {result.page > 1 && (
        <Link href={href(result.page - 1)} className="btn btn-secondary btn-sm">
          ← {t('search.previous')}
        </Link>
      )}

      {pages.map((page) => (
        <Link
          key={page}
          href={href(page)}
          className={`btn btn-sm ${page === result.page ? 'btn-primary' : 'btn-secondary'}`}
          aria-current={page === result.page ? 'page' : undefined}
        >
          {page}
        </Link>
      ))}

      {result.page < result.totalPages && (
        <Link href={href(result.page + 1)} className="btn btn-secondary btn-sm">
          {t('search.nextPage')} →
        </Link>
      )}
    </nav>
  );
}