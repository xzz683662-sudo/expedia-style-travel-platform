/**
 * Typed client for the EasyTrip API.
 *
 * Calls are made both server-side (React Server Components) and from the browser
 * after login, and the two want *different* URLs:
 *
 *   - Server components render inside the same network as the API, so they use
 *     the internal address. Routing them through a public tunnel would add a
 *     full round-trip to every page render.
 *   - The browser uses the storefront's own origin by default, and Next.js
 *     rewrites `/api/v1/*` to the API (see `next.config.ts`). That keeps the
 *     browser on a single origin, so there is no CORS preflight and no
 *     allowlist to keep in sync.
 *
 * Set `NEXT_PUBLIC_API_BASE_URL` only when the API genuinely lives on a separate
 * origin — it overrides the same-origin default and re-introduces CORS.
 */

const API_BASE =
  typeof window === 'undefined'
    ? (process.env.API_INTERNAL_URL ?? 'http://localhost:4000')
    : (process.env.NEXT_PUBLIC_API_BASE_URL ?? '');

const API_PREFIX = '/api/v1';

import { DEFAULT_LOCALE, type LocaleCode } from './i18n/config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  /** Return `null` instead of throwing on 404 - handy for optional modules. */
  soft404?: boolean;
  cache?: RequestCache;
  revalidate?: number;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, headers: extraHeaders, soft404, cache, revalidate } = options;

  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache,
    next: revalidate !== undefined ? { revalidate } : undefined,
  });

  if (response.status === 404 && soft404) return null as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details ?? error?.fields,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Shared shapes (mirrors of the API responses the UI consumes)
// ---------------------------------------------------------------------------

export type Money = { cents: number; currency: string };

export type SearchHit = {
  productId: string;
  slug: string;
  title: string;
  summary: string | null;
  type: string;
  imageUrl: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  ratingAvg: number;
  ratingCount: number;
  freeCancellation: boolean;
  instantConfirm: boolean;
  skipTheLine: boolean;
  destinationName: string | null;
  countryCode: string | null;
  distanceKm: number | null;
  badge: string | null;
  tags: string[];
  /**
   * Category-specific facts from the API, so a card can show a flight's route
   * and cabin, a hotel's stars and board basis, or a cruise's ship and length
   * without a second request. Absent for categories that have no such fields.
   */
  category?: ProductCategoryInfo;
};

/** Mirrors the `category` block the search endpoint hydrates onto each hit. */
export type ProductCategoryInfo = {
  airlineName: string | null;
  flightRoute: string | null;
  cabinClass: string | null;
  roomCategory: string | null;
  starCategory: number | null;
  boardBasis: string | null;
  cruiseLine: string | null;
  shipName: string | null;
  cruiseNights: number | null;
  itineraryPorts: string[];
  groupSizeCap: number | null;
  privateDeparture: boolean;
};

export type Facets = {
  types: { value: string; label: string; count: number }[];
  destinations: { value: string; label: string; count: number }[];
  priceRange: { minCents: number; maxCents: number };
  ratings: { value: number; count: number }[];
  tags: { value: string; label: string; count: number }[];
};

/**
 * One category bucket of a unified search response. The API computes these in
 * the same pass as `items` / `facets`, so the category rails, the tab counts and
 * the flat list always describe the same snapshot of the catalogue.
 */
export type SearchGroup = {
  type: string;
  label: string;
  count: number;
  items: SearchHit[];
};

/** Category roll-up used to populate the unified search panel before any query. */
export type SearchCategory = {
  type: string;
  label: string;
  productCount: number;
  fromPriceCents: number;
};

export type SearchResponse = {
  items: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: Facets;
  groups: SearchGroup[];
  tookMs: number;
  engine: string;
};

export type Destination = {
  slug: string;
  name: string;
  countryCode: string | null;
  heroImageUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  productCount: number;
};

export type TicketType = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  currency: string;
  basePriceCents: number;
  compareAtPriceCents: number | null;
  unitPriceCents: number;
  taxCents: number;
  feeCents: number;
  markupCents: number;
  totalPerUnitCents: number;
  lineTotalCents: number;
  discountCents: number;
  inventoryMode: string;
  maxPerOrder: number;
  minPerOrder: number;
  isRefundable: boolean;
  isTransferable: boolean;
  requiresPassport: boolean;
  appliedRules: { ruleId: string; name: string; deltaCents: number; note: string }[];
};

export type ProductDetail = {
  id: string;
  slug: string;
  type: string;
  fulfillment: string;
  name: string;
  summary: string | null;
  description: string | null;
  highlights: string[];
  includes: string[];
  excludes: string[];
  meetingPoint: string | null;
  media: { url: string; type: string; altText: string | null }[];
  tags: { slug: string; label: string }[];
  destination: { slug: string; name: string; level: string; countryCode: string | null; parent: string | null } | null;
  location: { latitude: number | null; longitude: number | null; addressLine: string | null; timezone: string };
  flags: {
    instantConfirm: boolean;
    mobileTicket: boolean;
    freeCancellation: boolean;
    skipTheLine: boolean;
    wheelchairAccessible: boolean;
    languages: string[];
    durationMinutes: number | null;
    minAge: number | null;
    maxAge: number | null;
  };
  merchant: { id: string; name: string; slug: string; ratingAvg: number; ratingCount: number } | null;
  rating: {
    average: number;
    count: number;
    breakdown: { stars: number; count: number; percent: number }[];
  };
  cancellationPolicy: {
    refundType: string;
    freeCancelHours: number;
    tiers: { minHoursBefore: number; refundBps: number }[];
    description: string | null;
  } | null;
  selectedDate: string;
  quantity: number;
  ticketTypes: TicketType[];
  reviews: {
    id: string;
    rating: number;
    title: string | null;
    body: string;
    helpfulCount: number;
    merchantReply: string | null;
    createdAt: string;
    verified: boolean;
    author: { name: string; avatarUrl: string | null; countryCode: string | null } | null;
    media: string[];
  }[];
  similar: {
    productId: string;
    slug: string;
    title: string;
    imageUrl: string | null;
    priceCents: number;
    currency: string;
    ratingAvg: number;
    ratingCount: number;
    badge: string | null;
  }[];
};

export type AvailabilityDay = {
  date: string;
  status: 'AVAILABLE' | 'LIMITED' | 'SOLD_OUT' | 'CLOSED';
  availableQty: number;
  minPriceCents: number;
};

export type CheckoutResult = {
  orderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totalCents: number;
  holds: { holdToken: string; expiresAt: string }[];
};

export type CartItem = {
  id: string;
  productId: string;
  slug: string;
  productType: string;
  title: string;
  imageUrl: string | null;
  ticketTypeId: string;
  optionName: string;
  serviceDate: string;
  timeSlot: string | null;
  quantity: number;
  minPerOrder: number;
  maxPerOrder: number;
  unitPriceCents: number;
  currency: string;
  lineTotalCents: number;
};

export type Cart = {
  id: string;
  currency: string;
  status: string;
  items: CartItem[];
  guestToken?: string;
};

export type WishlistItem = {
  productId: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  serviceDate: string | null;
  createdAt: string;
};

export type ItineraryItem = {
  id: string;
  orderId: string | null;
  productId: string | null;
  day: number;
  position: number;
  title: string;
  notes: string | null;
  costCents: number;
};

export type Itinerary = {
  id: string;
  name: string;
  destinationSummary: string | null;
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  itemCount: number;
  isPublic: boolean;
  items: ItineraryItem[];
};

export type OrderSummary = {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  totalCents: number;
  placedAt: string;
  itemCount: number;
  ticketCount: number;
  items: {
    productName: string;
    productSlug: string;
    thumbnailUrl: string | null;
    serviceDate: string;
    timeSlot: string | null;
    quantity: number;
  }[];
};

export type OrderDetail = {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  contactEmail: string;
  totals: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    markupCents: number;
    totalCents: number;
    refundedCents: number;
    pointsEarned: number;
  };
  placedAt: string;
  items: {
    id: string;
    productName: string;
    productSlug: string;
    thumbnailUrl: string | null;
    ticketTypeName: string;
    serviceDate: string;
    timeSlot: string | null;
    quantity: number;
    lineTotalCents: number;
    destination: string | null;
    meetingPoint: string | null;
  }[];
  tickets: {
    id: string;
    ticketNumber: string;
    productName: string;
    status: string;
    qrImageUrl: string | null;
    pdfUrl: string | null;
    barcode: string;
    serviceDate: string;
    timeSlot: string | null;
    destinationName: string | null;
    holderName: string;
    items: { id: string; name: string; status: string; redeemedQty: number }[];
    scans: { scannedAt: string; gateName: string | null; result: string }[];
  }[];
  timeline: { from: string | null; to: string; reason: string | null; createdAt: string }[];
  refunds: { id: string; amountCents: number; reason: string; processedAt: string }[];
};

export type CancellationQuote = {
  refundable: boolean;
  refundCents: number;
  penaltyCents: number;
  refundBps: number;
  reason: string;
};

/**
 * In-app notification row.
 *
 * `payload` carries the event context (`orderNumber`, `status`, `refundCents`,
 * …) so the notification centre can render a meaningful line and deep-link into
 * the order without a second request.
 */
export type AppNotification = {
  id: string;
  channel: string;
  status: string;
  template: string;
  subject: string | null;
  locale: string;
  payload: Record<string, unknown> | null;
  orderId: string | null;
  orderNumber: string | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationsResponse = {
  items: AppNotification[];
  unread: number;
  nextCursor: string | null;
};

export type DashboardData = {
  kpis: {
    orders30d: number;
    grossRevenueCents: number;
    refundedCents: number;
    netRevenueCents: number;
    averageOrderValueCents: number;
    pendingOperations: number;
    refundRate: number;
  };
  recentOrders: {
    id: string;
    orderNumber: string;
    status: string;
    totalCents: number;
    currency: string;
    placedAt: string;
    customer: string;
    itemCount: number;
    ticketCount: number;
  }[];
  topProducts: { productId: string; productName: string; revenueCents: number; units: number }[];
  criticalInventory: {
    ticketTypeId: string;
    productName: string;
    serviceDate: string;
    timeSlot: string | null;
    remaining: number;
    capacityTotal: number;
  }[];
};

export type ScanResult = {
  valid: boolean;
  result: string;
  message: string;
  ticket?: {
    ticketNumber: string;
    productName: string;
    holderName: string;
    serviceDate: string;
    timeSlot: string | null;
    destinationName: string | null;
    partySize: number;
    redeemedSeats: number;
  };
};

// ---------------------------------------------------------------------------
// Promotional banners
// ---------------------------------------------------------------------------

/** Already localised by the API — `title` is whichever language was resolved. */
export type PromoBanner = {
  id: string;
  slot: string;
  title: string;
  body: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  theme: 'brand' | 'accent' | 'success' | 'warning' | 'neutral';
  sortOrder: number;
};

export type PromoBannerAdmin = {
  id: string;
  slot: string;
  titleEn: string;
  titleZh: string | null;
  bodyEn: string | null;
  bodyZh: string | null;
  ctaLabelEn: string | null;
  ctaLabelZh: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  theme: string;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  sortOrder: number;
  markets: string[];
  locales: string[];
  clickCount: number;
  createdAt: string;
};

export type PromoBannerInput = {
  slot: string;
  titleEn: string;
  titleZh?: string | null;
  bodyEn?: string | null;
  bodyZh?: string | null;
  ctaLabelEn?: string | null;
  ctaLabelZh?: string | null;
  ctaHref?: string | null;
  imageUrl?: string | null;
  theme?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  markets?: string[];
  locales?: string[];
};

// ---------------------------------------------------------------------------
// Support console
// ---------------------------------------------------------------------------

export type SupportCustomer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  locale: string;
  countryCode: string | null;
  role: string;
  avatarUrl: string | null;
  marketingOptIn: boolean;
  emailVerified: boolean;
  createdAt: string;
  walletCents: number;
  walletEnabled: boolean;
  loyaltyPoints: number;
  loyaltyTier: string;
  lifetimePoints: number;
  orderCount: number;
  reviewCount: number;
};

export type SupportCustomerDetail = SupportCustomer & {
  orders: {
    id: string;
    orderNumber: string;
    status: string;
    totalCents: number;
    currency: string;
    placedAt: string;
  }[];
  walletTransactions: {
    id: string;
    kind: string;
    amountCents: number;
    currency: string;
    balanceAfterCents: number;
    orderId: string | null;
    note: string | null;
    actorEmail: string | null;
    createdAt: string;
  }[];
};

export type SupportOrderSummary = {
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  refundedCents: number;
  currency: string;
  placedAt: string;
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    walletCents: number;
  };
  ticketCount: number;
};

export type CouponVerification = {
  valid: boolean;
  reason: string;
  code?: string;
  description?: string | null;
  discountType?: string;
  discountValue?: number;
  maxDiscountCents?: number | null;
  minOrderCents?: number;
  currency?: string | null;
  usageLimit?: number | null;
  usageCount?: number;
  perUserLimit?: number;
  stackable?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type AuditEntry = {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type SearchParams = Record<string, string | number | boolean | undefined | null>;

function toQuery(params: SearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Every locale-sensitive endpoint goes through here.
 *
 * The API resolves translations from `?locale=`, and without it the server
 * falls back to `en-US` — which is why a Chinese page could show an English
 * `<title>`-adjacent rail heading ("Landmark access") while the surrounding
 * copy was correctly Chinese. Injecting the locale at the client means no call
 * site can forget it, and the UI's locale is already resolved per request by
 * the server components.
 */
function withLocale<T extends SearchParams>(params: T, locale: LocaleCode): T & { locale: string } {
  return { ...params, locale: locale === 'zh' ? 'zh-CN' : 'en-US' };
}

export const api = {
  health: () => fetch(`${API_BASE}/health`).then((r) => r.json()),

  search: (params: SearchParams = {}, token?: string | null, locale: LocaleCode = DEFAULT_LOCALE) =>
    request<SearchResponse>(`/search${toQuery(withLocale(params, locale))}`, { token, revalidate: 30 }),

  /** Category roll-up for the unified search panel (counts per product type). */
  searchCategories: (params: SearchParams = {}, locale: LocaleCode = DEFAULT_LOCALE) =>
    request<{ categories: SearchCategory[]; total: number }>(
      `/search/categories${toQuery(withLocale(params, locale))}`,
      { revalidate: 300 },
    ),

  destinations: () => request<Destination[]>('/destinations', { revalidate: 3600 }),

  collection: (slug: string, token?: string | null, locale: LocaleCode = DEFAULT_LOCALE) =>
    request<SearchResponse & { title: string }>(`/collections/${slug}${toQuery(withLocale({}, locale))}`, {
      token,
      revalidate: 300,
    }),

  product: (slug: string, params: SearchParams = {}, locale: LocaleCode = DEFAULT_LOCALE) =>
    request<ProductDetail>(`/products/${slug}${toQuery(withLocale(params, locale))}`, { revalidate: 60 }),

  availability: (slug: string, days = 90) =>
    request<{ from: string; days: AvailabilityDay[] }>(`/products/${slug}/availability${toQuery({ days })}`, {
      revalidate: 30,
    }),

  reviews: (slug: string, params: SearchParams = {}) =>
    request<{
      summary: { average: number; total: number; recommendedPercent: number; breakdown: { stars: number; count: number; percent: number }[] };
      items: ProductDetail['reviews'];
      total: number;
      page: number;
      totalPages: number;
    }>(`/products/${slug}/reviews${toQuery(params)}`, { revalidate: 60 }),

  // --- Auth ---
  register: (body: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    locale?: string;
    countryCode?: string;
  }) =>
    request<{ token: string; user: { id: string; email: string; firstName: string; lastName: string } }>('/auth/register', {
      method: 'POST',
      body,
    }),

  login: (body: { email: string; password: string }) =>
    request<{
      token: string;
      user: { id: string; email: string; firstName: string; lastName: string; loyalty: { tier: string; points: number } | null };
    }>('/auth/login', { method: 'POST', body }),

  me: (token: string) =>
    request<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string | null;
      locale: string;
      role: string;
      marketingOptIn: boolean;
      loyalty: {
        tier: string;
        points: number;
        lifetimePoints: number;
        transactions: { id: string; kind: string; points: number; note: string | null; createdAt: string }[];
      } | null;
      travelers: { id: string; fullName: string; email: string | null; isDefault: boolean }[];
      stats: { orders: number; reviews: number; wishlist: number };
    }>('/auth/me', { token, cache: 'no-store' }),

  // --- Checkout & orders ---
  createOrder: (body: {
    lines: { ticketTypeId: string; serviceDate: string; timeSlot?: string | null; quantity: number }[];
    contactEmail: string;
    contactPhone?: string;
    couponCode?: string;
    travelers?: { fullName: string; email?: string; isLead?: boolean }[];
    addOns?: { addOnId: string; quantity: number }[];
    locale?: string;
    market?: string;
    channel?: string;
  }, token?: string | null) => request<CheckoutResult>('/orders', { method: 'POST', body, token }),

  cart: (
    token?: string | null,
    guestToken?: string | null,
    locale: LocaleCode = DEFAULT_LOCALE,
  ) =>
    request<Cart>(`/cart${toQuery(withLocale({}, locale))}`, {
      token,
      headers: guestToken ? { 'X-Cart-Token': guestToken } : undefined,
      cache: 'no-store',
    }),

  addCartItem: (
    body: { ticketTypeId: string; serviceDate: string; timeSlot?: string | null; quantity: number },
    token?: string | null,
    guestToken?: string | null,
    locale: LocaleCode = DEFAULT_LOCALE,
  ) =>
    request<Cart>(`/cart/items${toQuery(withLocale({}, locale))}`, {
      method: 'POST',
      body,
      token,
      headers: guestToken ? { 'X-Cart-Token': guestToken } : undefined,
      cache: 'no-store',
    }),

  updateCartItem: (
    id: string,
    body: { quantity: number },
    token?: string | null,
    guestToken?: string | null,
    locale: LocaleCode = DEFAULT_LOCALE,
  ) =>
    request<Cart>(`/cart/items/${encodeURIComponent(id)}${toQuery(withLocale({}, locale))}`, {
      method: 'PATCH',
      body,
      token,
      headers: guestToken ? { 'X-Cart-Token': guestToken } : undefined,
      cache: 'no-store',
    }),

  removeCartItem: (
    id: string,
    token?: string | null,
    guestToken?: string | null,
    locale: LocaleCode = DEFAULT_LOCALE,
  ) =>
    request<Cart>(`/cart/items/${encodeURIComponent(id)}${toQuery(withLocale({}, locale))}`, {
      method: 'DELETE',
      token,
      headers: guestToken ? { 'X-Cart-Token': guestToken } : undefined,
      cache: 'no-store',
    }),

  checkoutCart: (
    body: {
      contactEmail: string;
      contactPhone?: string;
      customerNote?: string;
      couponCode?: string;
      travelers?: { fullName: string; email?: string }[];
    },
    token?: string | null,
    guestToken?: string | null,
    locale: LocaleCode = DEFAULT_LOCALE,
  ) =>
    request<CheckoutResult>(`/cart/checkout${toQuery(withLocale({}, locale))}`, {
      method: 'POST',
      body,
      token,
      headers: guestToken ? { 'X-Cart-Token': guestToken } : undefined,
      cache: 'no-store',
    }),

  // --- Customer trip tools ---
  wishlist: (token: string) =>
    request<WishlistItem[]>('/wishlist', { token, cache: 'no-store' }),

  addWishlistItem: (body: { productId: string; serviceDate?: string }, token: string) =>
    request<{ id: string; productId: string; serviceDate: string | null }>('/wishlist', { method: 'POST', body, token }),

  removeWishlistItem: (productId: string, token: string) =>
    request<{ removed: boolean }>(`/wishlist/${encodeURIComponent(productId)}`, { method: 'DELETE', token }),

  itineraries: (token: string) =>
    request<Itinerary[]>('/itineraries', { token, cache: 'no-store' }),

  createItinerary: (
    body: { name: string; destinationSummary?: string; startDate?: string; endDate?: string },
    token: string,
  ) => request<Itinerary>('/itineraries', { method: 'POST', body, token }),

  addOrderToItinerary: (
    itineraryId: string,
    body: { orderId: string; day?: number; notes?: string },
    token: string,
  ) =>
    request<ItineraryItem[]>(`/itineraries/${encodeURIComponent(itineraryId)}/items`, {
      method: 'POST',
      body,
      token,
    }),

  payOrder: (
    orderId: string,
    body: {
      method: string;
      idempotencyKey: string;
      card?: { number: string; expMonth: number; expYear: number; cvc: string; holderName?: string };
    },
    token?: string | null,
  ) =>
    request<{ paymentId: string; status: string; clientSecret?: string; failureMessage?: string }>(
      `/orders/${orderId}/pay`,
      { method: 'POST', body, token },
    ),

  orders: (params: SearchParams = {}, token: string) =>
    request<{ items: OrderSummary[]; total: number; page: number; totalPages: number }>(`/orders${toQuery(params)}`, {
      token,
      cache: 'no-store',
    }),

  order: (orderId: string, token: string) => request<OrderDetail>(`/orders/${orderId}`, { token, cache: 'no-store' }),

  cancellationQuote: (orderId: string, token: string) =>
    request<CancellationQuote>(`/orders/${orderId}/cancellation-quote`, { token, cache: 'no-store' }),

  cancelOrder: (orderId: string, body: { reason?: string }, token: string) =>
    request<{ refundCents: number; status: string }>(`/orders/${orderId}/cancel`, { method: 'POST', body, token }),

  // --- Notification centre ---
  notifications: (params: SearchParams = {}, token?: string | null) =>
    request<NotificationsResponse>(`/notifications${toQuery(params)}`, { token, cache: 'no-store' }),

  markNotificationRead: (id: string, token: string) =>
    request<{ ok: boolean; unread: number }>(`/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      token,
    }),

  markAllNotificationsRead: (token: string) =>
    request<{ ok: boolean; unread: number }>('/notifications/read-all', { method: 'POST', token }),

  // --- Tickets ---
  tickets: (token: string) =>
    request<
      {
        id: string;
        ticketNumber: string;
        orderNumber: string | null;
        productName: string;
        destinationName: string | null;
        status: string;
        serviceDate: string;
        timeSlot: string | null;
        holderName: string;
        qrImageUrl: string | null;
        pdfUrl: string | null;
      }[]
    >('/tickets', { token, cache: 'no-store' }),

  // --- Loyalty ---
  loyaltyAccount: (token: string) =>
    request<{
      tier: string;
      points: number;
      lifetimePoints: number;
      balanceValueCents: number;
      nextTier: { tier: string; pointsNeeded: number; progress: number } | null;
    }>('/loyalty/account', { token, cache: 'no-store' }),

  loyaltyProgram: () =>
    request<{ tiers: { tier: string; threshold: number; perks: string[] }[]; earnRate: string; redeemRate: string }>(
      '/loyalty/program',
      { revalidate: 3600 },
    ),

  // --- Reviews ---
  addReview: (
    slug: string,
    body: { rating: number; title?: string; body: string; orderId?: string },
    token: string,
  ) => request<{ id: string }>(`/products/${slug}/reviews`, { method: 'POST', body, token }),

  // --- Operator console ---
  adminDashboard: (token: string) => request<DashboardData>('/admin/dashboard', { token, cache: 'no-store' }),

  adminProducts: (params: SearchParams, token: string) =>
    request<{
      items: {
        id: string;
        slug: string;
        name: string;
        type: string;
        status: string;
        destination: string | null;
        merchant: string;
        ratingAvg: number;
        reviewCount: number;
        variants: number;
        priceFromCents: number;
        currency: string;
      }[];
      total: number;
      page: number;
      totalPages: number;
    }>(`/admin/products${toQuery(params)}`, { token, cache: 'no-store' }),

  adminOrders: (params: SearchParams, token: string) =>
    request<{
      items: {
        id: string;
        orderNumber: string;
        status: string;
        totalCents: number;
        refundedCents: number;
        currency: string;
        customer: string;
        unitCount: number;
        placedAt: string;
      }[];
      total: number;
      page: number;
      totalPages: number;
    }>(`/admin/orders${toQuery(params)}`, { token, cache: 'no-store' }),

  adminInventory: (params: SearchParams, token: string) =>
    request<
      {
        id: string;
        ticketTypeName: string;
        productName: string;
        serviceDate: string;
        timeSlot: string | null;
        total: number;
        held: number;
        sold: number;
        available: number;
        status: string;
      }[]
    >(`/admin/inventory${toQuery(params)}`, { token, cache: 'no-store' }),

  adjustInventory: (
    body: { ticketTypeId: string; from: string; days: number; capacity: number; closeDates?: boolean },
    token: string,
  ) => request<{ rows?: number; closed?: boolean }>('/admin/inventory/adjust', { method: 'POST', body, token }),

  simulatePricing: (
    body: { productId: string; serviceDate: string; quantity: number },
    token: string,
  ) =>
    request<
      {
        ticketTypeId: string;
        name: string;
        basePriceCents: number;
        finalPriceCents: number;
        taxCents: number;
        totalPerUnitCents: number;
        appliedRules: { name: string; deltaCents: number; note: string }[];
      }[]
    >('/admin/pricing/simulate', { method: 'POST', body, token }),

  // --- Gate operations ---
  scanVerify: (body: { code: string; gate?: string; commit?: boolean }, token: string) =>
    request<ScanResult>('/scan/verify', { method: 'POST', body, token }),

  scanStats: (token: string, gate?: string) =>
    request<{
      date: string;
      ticketsToday: number;
      admitted: number;
      noShowRate: number;
      recent: { scannedAt: string; gateName: string | null; result: string; ticketNumber: string | null; holderName: string | null }[];
    }>(`/scan/stats${toQuery({ gate })}`, { token, cache: 'no-store' }),

  // --- Promotional banners ---
  promoBanners: (params: SearchParams = {}) =>
    request<{
      locale: string;
      market: string;
      banners: PromoBanner[];
      grouped: Record<string, PromoBanner[]>;
    }>(`/promo/banners${toQuery(params)}`, { revalidate: 60 }),

  adminPromoBanners: (token: string) =>
    request<{ items: PromoBannerAdmin[] }>('/admin/promo/banners', { token, cache: 'no-store' }),

  createPromoBanner: (body: PromoBannerInput, token: string) =>
    request<PromoBannerAdmin>('/admin/promo/banners', { method: 'POST', body, token }),

  updatePromoBanner: (id: string, body: Partial<PromoBannerInput>, token: string) =>
    request<PromoBannerAdmin>(`/admin/promo/banners/${id}`, { method: 'PATCH', body, token }),

  deletePromoBanner: (id: string, token: string) =>
    request<{ ok: boolean }>(`/admin/promo/banners/${id}`, { method: 'DELETE', token }),

  trackPromoClick: (id: string) =>
    request<{ ok: boolean }>(`/promo/banners/${id}/click`, { method: 'POST' }),

  // --- Support console ---
  supportCustomers: (params: SearchParams, token: string) =>
    request<{ items: SupportCustomer[]; nextCursor: string | null }>(`/support/customers${toQuery(params)}`, {
      token,
      cache: 'no-store',
    }),

  supportCustomer: (id: string, token: string) =>
    request<SupportCustomerDetail>(`/support/customers/${id}`, { token, cache: 'no-store' }),

  updateSupportCustomer: (
    id: string,
    body: {
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      locale?: string;
      countryCode?: string | null;
      marketingOptIn?: boolean;
      walletEnabled?: boolean;
      loyaltyPoints?: number;
      loyaltyTier?: string;
    },
    token: string,
  ) => request<{ ok: boolean }>(`/support/customers/${id}`, { method: 'PATCH', body, token }),

  adjustWallet: (
    id: string,
    body: { amountCents: number; currency?: string; note: string },
    token: string,
  ) =>
    request<{ ok: boolean; balanceCents: number; transactionId: string }>(
      `/support/customers/${id}/wallet`,
      { method: 'POST', body, token },
    ),

  supportOrders: (params: SearchParams, token: string) =>
    request<{ items: SupportOrderSummary[] }>(`/support/orders/lookup${toQuery(params)}`, {
      token,
      cache: 'no-store',
    }),

  supportRefund: (orderId: string, body: { amountCents: number; reason: string }, token: string) =>
    request<{ ok: boolean; refundedCents: number; walletCents: number }>(`/support/orders/${orderId}/refund`, {
      method: 'POST',
      body,
      token,
    }),

  verifyCoupon: (code: string, token: string) =>
    request<CouponVerification>(`/support/coupons/${encodeURIComponent(code)}/verify`, {
      token,
      cache: 'no-store',
    }),

  supportAudit: (params: SearchParams, token: string) =>
    request<{ items: AuditEntry[] }>(`/support/audit${toQuery(params)}`, { token, cache: 'no-store' }),
};

export { API_BASE };

/**
 * Ticket artefacts are stored as `file://` URLs when object storage is not
 * configured (the default in local development). Browsers cannot load those, so
 * rewrite them onto the API's `/media` route. S3/MinIO URLs pass through
 * untouched.
 */
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith('file://')) return url;

  const path = url.slice('file://'.length);
  const marker = '/tickets/';
  const index = path.lastIndexOf(marker);
  if (index === -1) return null;

  const ticketNumber = path.slice(index + marker.length).split('/')[0];
  const file = path.slice(path.lastIndexOf('/') + 1);
  // Always relative. `/media` is proxied by Next on the storefront's own origin
  // (see `next.config.ts`), so building an absolute URL here would bake in
  // whichever host happened to render — and SSR would emit `localhost:4000`,
  // which is unreachable from a visitor's browser.
  return `/media/tickets/${ticketNumber}/${file}`;
}