/**
 * ---------------------------------------------------------------------------
 * EasyTrip seed catalogue
 * ---------------------------------------------------------------------------
 *
 * Deterministic, dependency-free seed data for the self-inventory catalogue:
 * destinations, products, ticket variants, pricing rules, inventory, coupons,
 * demo customers and a sample of paid orders with issued tickets.
 *
 * The content targets a global market: pricing in USD/EUR/GBP/AUD/SGD, correct
 * timezones per city, and copy written in the locale each product serves.
 */

export type SeedDestination = {
  slug: string;
  name: string;
  level: 'COUNTRY' | 'REGION' | 'CITY' | 'ATTRACTION';
  countryCode: string;
  timezone: string;
  latitude: number;
  longitude: number;
  isPopular?: boolean;
  sortWeight?: number;
  description?: string;
  heroImageUrl?: string;
};

export type SeedTicketType = {
  code: string;
  name: string;
  description?: string;
  basePriceCents: number;
  compareAtCents?: number;
  costCents: number;
  currency?: string;
  taxBps?: number;
  feeBps?: number;
  inventoryMode?: 'PER_DATE' | 'PER_SLOT' | 'PER_NIGHT' | 'PER_HOUR' | 'UNLIMITED';
  maxPerOrder?: number;
  minPerOrder?: number;
  isRefundable?: boolean;
  isTransferable?: boolean;
  requiresPassport?: boolean;
  capacity?: number;
  timeSlots?: string[];
  netPriceCents?: number;
};

export type SeedPriceRule = {
  scope: 'PRODUCT' | 'TICKET_TYPE';
  ticketCode?: string;
  kind:
    | 'DATE_RANGE'
    | 'DAY_OF_WEEK'
    | 'SEASON'
    | 'LEAD_TIME'
    | 'QUANTITY_BREAK'
    | 'FLASH_SALE'
    | 'EARLY_BIRD';
  name: string;
  priority?: number;
  conditions: Record<string, unknown>;
  adjustment: Record<string, unknown>;
  minQuantity?: number;
  startsAt?: string;
  endsAt?: string;
};

export type SeedProduct = {
  slug: string;
  type:
    | 'ATTRACTION_TICKET'
    | 'ACTIVITY'
    | 'TOUR'
    | 'DAY_TRIP'
    | 'PACKAGE'
    | 'HOTEL_ROOM'
    | 'TRANSFER'
    | 'GUIDED_TOUR'
    | 'CRUISE'
    | 'RESTAURANT'
    | 'VEHICLE_RENTAL'
    | 'AIRPORT_TRANSFER'
    | 'FLIGHT';
  fulfillment?: 'INSTANT_TICKET' | 'CONFIRMATION' | 'ON_SITE_PAYMENT';
  destinationSlug: string;
  merchantSlug?: string;
  latitude: number;
  longitude: number;
  addressLine?: string;
  meetingPoint?: string;
  timezone: string;
  defaultLocale?: string;
  /** English display name. Falls back to a humanised slug when omitted. */
  name?: string;
  summary: string;
  description: string;
  highlights: string[];
  includes: string[];
  excludes: string[];
  amenities?: string[];
  audience?: string[];
  languages?: string[];
  instantConfirm?: boolean;
  mobileTicket?: boolean;
  freeCancellation?: boolean;
  skipTheLine?: boolean;
  ticketOnly?: boolean;
  wheelchairAccessible?: boolean;
  durationMinutes?: number;
  minAge?: number;
  maxAge?: number;
  // --- Category-specific display fields (mirror the Product columns) ---
  /** FLIGHT: e.g. "Singapore Airlines" */
  airlineName?: string;
  /** FLIGHT: e.g. "SIN → LHR" */
  flightRoute?: string;
  /** FLIGHT: e.g. "Business" */
  cabinClass?: string;
  /** HOTEL_ROOM: e.g. "Deluxe King" */
  roomCategory?: string;
  /** HOTEL_ROOM: 1-5 official stars. */
  starCategory?: number;
  /** HOTEL_ROOM: e.g. "Breakfast included" */
  boardBasis?: string;
  /** CRUISE: e.g. "Viking" */
  cruiseLine?: string;
  /** CRUISE: e.g. "Viking Grace" */
  shipName?: string;
  /** CRUISE: length in nights. */
  cruiseNights?: number;
  /** CRUISE: ports of call, shown as an itinerary strip. */
  itineraryPorts?: string[];
  /** GUIDED_TOUR/ACTIVITY: max guests per departure. */
  groupSizeCap?: number;
  /** GUIDED_TOUR/ACTIVITY: bookable as an exclusive private use. */
  privateDeparture?: boolean;
  tags: string[];
  media: { url: string; altText: string }[];
  /**
   * Extra locales beyond the default one. The seed always writes an `en`
   * translation from the top-level copy; entries here add `zh` (and any other
   * locale a product genuinely serves), so every listing is bilingual.
   */
  translations?: {
    locale: string;
    name: string;
    summary: string;
    highlights?: string[];
  }[];
  ticketTypes: SeedTicketType[];
  priceRules?: SeedPriceRule[];
  cancellationPolicy?: {
    freeCancelHours: number;
    tiers: { minHoursBefore: number; refundBps: number }[];
    adminFeeCents: number;
    description: string;
  };
  /** Deterministic review seeding so ratings look real. */
  reviews?: {
    rating: number;
    title: string;
    body: string;
    author: string;
    daysAgo: number;
    /** Defaults to 'en'. Seed a parallel 'zh' review to make the page bilingual. */
    locale?: string;
    /** Deterministic instead of random, so re-seeding does not churn ratings. */
    helpfulCount?: number;
  }[];
};

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export const DESTINATIONS: SeedDestination[] = [
  // =========================================================================
  // Countries (ancestors so search by country works)
  // =========================================================================
  { slug: 'united-states', name: 'United States', level: 'COUNTRY', countryCode: 'US', timezone: 'America/New_York', latitude: 39.8283, longitude: -98.5795 },
  { slug: 'united-kingdom', name: 'United Kingdom', level: 'COUNTRY', countryCode: 'GB', timezone: 'Europe/London', latitude: 54.0, longitude: -2.0 },
  { slug: 'france', name: 'France', level: 'COUNTRY', countryCode: 'FR', timezone: 'Europe/Paris', latitude: 46.2276, longitude: 2.2137 },
  { slug: 'italy', name: 'Italy', level: 'COUNTRY', countryCode: 'IT', timezone: 'Europe/Rome', latitude: 41.8719, longitude: 12.5674 },
  { slug: 'spain', name: 'Spain', level: 'COUNTRY', countryCode: 'ES', timezone: 'Europe/Madrid', latitude: 40.4637, longitude: -3.7492 },
  { slug: 'germany', name: 'Germany', level: 'COUNTRY', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 51.1657, longitude: 10.4515 },
  { slug: 'netherlands', name: 'Netherlands', level: 'COUNTRY', countryCode: 'NL', timezone: 'Europe/Amsterdam', latitude: 52.1326, longitude: 5.2913 },
  { slug: 'switzerland', name: 'Switzerland', level: 'COUNTRY', countryCode: 'CH', timezone: 'Europe/Zurich', latitude: 46.8182, longitude: 8.2275 },
  { slug: 'austria', name: 'Austria', level: 'COUNTRY', countryCode: 'AT', timezone: 'Europe/Vienna', latitude: 47.5162, longitude: 14.5501 },
  { slug: 'portugal', name: 'Portugal', level: 'COUNTRY', countryCode: 'PT', timezone: 'Europe/Lisbon', latitude: 39.3999, longitude: -8.2245 },
  { slug: 'canada', name: 'Canada', level: 'COUNTRY', countryCode: 'CA', timezone: 'America/Toronto', latitude: 56.1304, longitude: -106.3468 },
  { slug: 'japan', name: 'Japan', level: 'COUNTRY', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 36.2048, longitude: 138.2529 },
  { slug: 'singapore', name: 'Singapore', level: 'COUNTRY', countryCode: 'SG', timezone: 'Asia/Singapore', latitude: 1.3521, longitude: 103.8198 },
  { slug: 'australia', name: 'Australia', level: 'COUNTRY', countryCode: 'AU', timezone: 'Australia/Sydney', latitude: -25.2744, longitude: 133.7751 },

  // =========================================================================
  // Europe — United Kingdom
  // =========================================================================
  { slug: 'london', name: 'London', level: 'CITY', countryCode: 'GB', timezone: 'Europe/London', latitude: 51.5074, longitude: -0.1278, isPopular: true, sortWeight: 1, description: 'Royal residences, world-class museums and the West End.', heroImageUrl: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=1200&q=80' },
  { slug: 'edinburgh', name: 'Edinburgh', level: 'CITY', countryCode: 'GB', timezone: 'Europe/London', latitude: 55.9533, longitude: -3.1883, isPopular: true, sortWeight: 2, description: 'Castles on the escarpment and the Highlands beyond.', heroImageUrl: 'https://images.unsplash.com/photo-1506377585622-bedcbb027afc?w=1200&q=80' },
  { slug: 'bath', name: 'Bath', level: 'CITY', countryCode: 'GB', timezone: 'Europe/London', latitude: 51.3811, longitude: -2.3590, isPopular: true, sortWeight: 24, description: 'Georgian architecture built on Roman springs.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/08/Roman_Baths_in_Bath_Spa%2C_England_-_July_2006.jpg/1280px-Roman_Baths_in_Bath_Spa%2C_England_-_July_2006.jpg' },

  // =========================================================================
  // Europe — France
  // =========================================================================
  { slug: 'paris', name: 'Paris', level: 'CITY', countryCode: 'FR', timezone: 'Europe/Paris', latitude: 48.8566, longitude: 2.3522, isPopular: true, sortWeight: 3, description: 'The City of Light, from the Louvre to Montmartre.', heroImageUrl: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=1200&q=80' },
  { slug: 'nice', name: 'Nice', level: 'CITY', countryCode: 'FR', timezone: 'Europe/Paris', latitude: 43.7102, longitude: 7.2620, isPopular: true, sortWeight: 25, description: 'Belle Époque arcades on the Promenade des Anglais.', heroImageUrl: 'https://images.unsplash.com/photo-1530841377377-3ff06c0ca713?w=1200&q=80' },
  { slug: 'lyon', name: 'Lyon', level: 'CITY', countryCode: 'FR', timezone: 'Europe/Paris', latitude: 45.7640, longitude: 4.8357, isPopular: true, sortWeight: 30, description: 'Two rivers, bouchons and the silk capital of Europe.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/97/Lyon-part-dieu-2023.jpg/1280px-Lyon-part-dieu-2023.jpg' },

  // =========================================================================
  // Europe — Italy
  // =========================================================================
  { slug: 'rome', name: 'Rome', level: 'CITY', countryCode: 'IT', timezone: 'Europe/Rome', latitude: 41.9028, longitude: 12.4964, isPopular: true, sortWeight: 4, description: 'The Eternal City — Colosseum, Vatican and Trastevere.', heroImageUrl: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=1200&q=80' },
  { slug: 'florence', name: 'Florence', level: 'CITY', countryCode: 'IT', timezone: 'Europe/Rome', latitude: 43.7696, longitude: 11.2558, isPopular: true, sortWeight: 5, description: 'Renaissance art, Brunelleschi’s dome and Tuscan kitchens.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3a/Firenze_-_Piazzale_Michelangelo%2C_Firenze%2C_Italy_-_April_6%2C_2015_02.jpg/1280px-Firenze_-_Piazzale_Michelangelo%2C_Firenze%2C_Italy_-_April_6%2C_2015_02.jpg' },
  { slug: 'venice', name: 'Venice', level: 'CITY', countryCode: 'IT', timezone: 'Europe/Rome', latitude: 45.4408, longitude: 12.3155, isPopular: true, sortWeight: 6, description: 'Canals, cicchetti and the lagoon at dawn.', heroImageUrl: 'https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?w=1200&q=80' },

  // =========================================================================
  // Europe — Spain
  // =========================================================================
  { slug: 'barcelona', name: 'Barcelona', level: 'CITY', countryCode: 'ES', timezone: 'Europe/Madrid', latitude: 41.3851, longitude: 2.1734, isPopular: true, sortWeight: 7, description: 'Gaudí modernism, the Mediterranean and Catalan kitchens.', heroImageUrl: 'https://images.unsplash.com/photo-1539037116277-4db20889f2d4?w=1200&q=80' },
  { slug: 'madrid', name: 'Madrid', level: 'CITY', countryCode: 'ES', timezone: 'Europe/Madrid', latitude: 40.4168, longitude: -3.7038, isPopular: true, sortWeight: 8, description: 'The Prado, the Royal Palace and late-night tapas.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/Madrid_-_Sky_Bar_360%C2%BA_%28Hotel_Riu_Plaza_Espa%C3%B1a%29%2C_vistas_19.jpg/1280px-Madrid_-_Sky_Bar_360%C2%BA_%28Hotel_Riu_Plaza_Espa%C3%B1a%29%2C_vistas_19.jpg' },
  { slug: 'seville', name: 'Seville', level: 'CITY', countryCode: 'ES', timezone: 'Europe/Madrid', latitude: 37.3891, longitude: -5.9845, isPopular: true, sortWeight: 9, description: 'Moorish palaces, flamenco and orange-blossom courtyards.', heroImageUrl: 'https://images.unsplash.com/photo-1558642084-fd07fae5282e?w=1200&q=80' },

  // =========================================================================
  // Europe — Germany
  // =========================================================================
  { slug: 'berlin', name: 'Berlin', level: 'CITY', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.5200, longitude: 13.4050, isPopular: true, sortWeight: 10, description: 'A city built in layers, from Prussian to modernist.', heroImageUrl: 'https://images.unsplash.com/photo-1560969184-10fe8719e047?w=1200&q=80' },
  { slug: 'munich', name: 'Munich', level: 'CITY', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 48.1351, longitude: 11.5820, isPopular: true, sortWeight: 11, description: 'Bavarian tradition beside modern art and engineering.', heroImageUrl: 'https://images.unsplash.com/photo-1560807707-8cc77767d783?w=1200&q=80' },

  // =========================================================================
  // Europe — Netherlands & Switzerland
  // =========================================================================
  { slug: 'amsterdam', name: 'Amsterdam', level: 'CITY', countryCode: 'NL', timezone: 'Europe/Amsterdam', latitude: 52.3676, longitude: 4.9041, isPopular: true, sortWeight: 12, description: 'Canal houses, the Van Gogh Museum and city cycling.', heroImageUrl: 'https://images.unsplash.com/photo-1534351590666-13e3e96b5017?w=1200&q=80' },
  { slug: 'zurich', name: 'Zurich', level: 'CITY', countryCode: 'CH', timezone: 'Europe/Zurich', latitude: 47.3769, longitude: 8.5417, isPopular: true, sortWeight: 13, description: 'A lakeside city between the Alps and Lake Lucerne.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/af/Altstadt_Z%C3%BCrich_2015.jpg/1280px-Altstadt_Z%C3%BCrich_2015.jpg' },
  { slug: 'interlaken', name: 'Interlaken', level: 'CITY', countryCode: 'CH', timezone: 'Europe/Zurich', latitude: 46.6863, longitude: 7.8632, isPopular: true, sortWeight: 26, description: 'Two lakes and the gateway to the Bernese Oberland.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/14/Goldswil-Viadukt_Panorama_mit_Interlaken_im_Hintergrund_2.jpg/1280px-Goldswil-Viadukt_Panorama_mit_Interlaken_im_Hintergrund_2.jpg' },

  // =========================================================================
  // Europe — Austria & Portugal
  // =========================================================================
  { slug: 'vienna', name: 'Vienna', level: 'CITY', countryCode: 'AT', timezone: 'Europe/Vienna', latitude: 48.2082, longitude: 16.3738, isPopular: true, sortWeight: 14, description: 'Imperial palaces, concert halls and coffee-house ritual.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5b/Schoenbrunn_philharmoniker_2012.jpg/1280px-Schoenbrunn_philharmoniker_2012.jpg' },
  { slug: 'salzburg', name: 'Salzburg', level: 'CITY', countryCode: 'AT', timezone: 'Europe/Vienna', latitude: 47.8095, longitude: 13.0550, isPopular: true, sortWeight: 27, description: 'The Baroque old town and the sound of Mozart.', heroImageUrl: 'https://images.unsplash.com/photo-1544984243-ec57ea16fe25?w=1200&q=80' },
  { slug: 'lisbon', name: 'Lisbon', level: 'CITY', countryCode: 'PT', timezone: 'Europe/Lisbon', latitude: 38.7223, longitude: -9.1393, isPopular: true, sortWeight: 15, description: 'Tiled façades, fado and the light on the Tagus.', heroImageUrl: 'https://images.unsplash.com/photo-1555881400-74d7acaacd8b?w=1200&q=80' },
  { slug: 'porto', name: 'Porto', level: 'CITY', countryCode: 'PT', timezone: 'Europe/Lisbon', latitude: 41.1579, longitude: -8.6291, isPopular: true, sortWeight: 28, description: 'Port lodges on the Douro and a city of seven hills.', heroImageUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e5/Puente_Don_Luis_I%2C_Oporto%2C_Portugal%2C_2012-05-09%2C_DD_13.JPG/1280px-Puente_Don_Luis_I%2C_Oporto%2C_Portugal%2C_2012-05-09%2C_DD_13.JPG' },

  // =========================================================================
  // North America — United States
  // =========================================================================
  { slug: 'new-york', name: 'New York', level: 'CITY', countryCode: 'US', timezone: 'America/New_York', latitude: 40.7128, longitude: -74.0060, isPopular: true, sortWeight: 16, description: 'Skyline, museums and Broadway, block by block.', heroImageUrl: 'https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?w=1200&q=80' },
  { slug: 'chicago', name: 'Chicago', level: 'CITY', countryCode: 'US', timezone: 'America/Chicago', latitude: 41.8781, longitude: -87.6298, isPopular: true, sortWeight: 33, description: 'Lakeside modernism, deep-dish pizza and a working waterfront.', heroImageUrl: 'https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=1200&q=80' },
  { slug: 'las-vegas', name: 'Las Vegas', level: 'CITY', countryCode: 'US', timezone: 'America/Los_Angeles', latitude: 36.1699, longitude: -115.1398, isPopular: true, sortWeight: 34, description: 'Resorts, showrooms and the gateway to the Southwest.', heroImageUrl: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1200&q=80' },
  { slug: 'los-angeles', name: 'Los Angeles', level: 'CITY', countryCode: 'US', timezone: 'America/Los_Angeles', latitude: 34.0522, longitude: -118.2437, isPopular: true, sortWeight: 17, description: 'From the Hollywood sign to the Pacific coast.', heroImageUrl: 'https://images.unsplash.com/photo-1534190760961-74e8c1c5c3da?w=1200&q=80' },
  { slug: 'san-francisco', name: 'San Francisco', level: 'CITY', countryCode: 'US', timezone: 'America/Los_Angeles', latitude: 37.7749, longitude: -122.4194, isPopular: true, sortWeight: 18, description: 'Golden Gate, hillside fog and the northern bay.', heroImageUrl: 'https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=1200&q=80' },
  { slug: 'miami', name: 'Miami', level: 'CITY', countryCode: 'US', timezone: 'America/New_York', latitude: 25.7617, longitude: -80.1918, isPopular: true, sortWeight: 19, description: 'Art Deco, turquoise water and a Latin pulse.', heroImageUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&q=80' },

  // =========================================================================
  // North America — Canada
  // =========================================================================
  { slug: 'toronto', name: 'Toronto', level: 'CITY', countryCode: 'CA', timezone: 'America/Toronto', latitude: 43.6532, longitude: -79.3832, isPopular: true, sortWeight: 20, description: 'A lakeside skyline with neighbourhoods to explore.', heroImageUrl: 'https://images.unsplash.com/photo-1517090504586-fde19ea6066f?w=1200&q=80' },
  { slug: 'vancouver', name: 'Vancouver', level: 'CITY', countryCode: 'CA', timezone: 'America/Vancouver', latitude: 49.2827, longitude: -123.1207, isPopular: true, sortWeight: 21, description: 'Mountains, seawall walks and Pacific light.', heroImageUrl: 'https://images.unsplash.com/photo-1559511260-66a654ae982a?w=1200&q=80' },

  // =========================================================================
  // Asia-Pacific
  // =========================================================================
  { slug: 'tokyo', name: 'Tokyo', level: 'CITY', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.6762, longitude: 139.6503, isPopular: true, sortWeight: 22, description: 'Centuries of ritual set beside hyper-modern design.', heroImageUrl: 'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=1200&q=80' },
  { slug: 'kyoto', name: 'Kyoto', level: 'CITY', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.0116, longitude: 135.7681, isPopular: true, sortWeight: 29, description: 'Temple gardens and the preserved streets of old Kyoto.', heroImageUrl: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=1200&q=80' },
  { slug: 'singapore-city', name: 'Singapore', level: 'CITY', countryCode: 'SG', timezone: 'Asia/Singapore', latitude: 1.3521, longitude: 103.8198, isPopular: true, sortWeight: 23, description: 'A garden city of extraordinary order and flavour.', heroImageUrl: 'https://images.unsplash.com/photo-1525625293386-3f8f99389edd?w=1200&q=80' },
  { slug: 'sydney', name: 'Sydney', level: 'CITY', countryCode: 'AU', timezone: 'Australia/Sydney', latitude: -33.8688, longitude: 151.2093, isPopular: true, sortWeight: 31, description: 'A harbour city with an operatic outlook.', heroImageUrl: 'https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9?w=1200&q=80' },
  { slug: 'melbourne', name: 'Melbourne', level: 'CITY', countryCode: 'AU', timezone: 'Australia/Melbourne', latitude: -37.8136, longitude: 144.9631, isPopular: true, sortWeight: 32, description: 'Laneway culture, coffee and great Australian sport.', heroImageUrl: 'https://images.unsplash.com/photo-1514395462725-fb4566210144?w=1200&q=80' },
];

// ---------------------------------------------------------------------------
// Merchants (stage-2 "partner" inventory)
// ---------------------------------------------------------------------------

export const MERCHANTS = [
  { name: 'EasyTrip Experiences', slug: 'easytrip-direct', description: 'Platform-owned experiences operated by the EasyTrip team.', commissionBps: 0, countryCode: 'US', status: 'ACTIVE' as const },
  { name: 'Big Apple Attractions', slug: 'big-apple-attractions', description: 'Official tickets for New York’s top attractions.', commissionBps: 1200, countryCode: 'US', status: 'ACTIVE' as const },
  { name: 'Côte d’Azur Transfers', slug: 'cote-azur-transfers', description: 'Private drivers and transfers along the Riviera.', commissionBps: 1500, countryCode: 'FR', status: 'ACTIVE' as const },
  { name: 'Tuscany Slow Travel', slug: 'tuscany-slow-travel', description: 'Small-group tours led by local historians.', commissionBps: 1800, countryCode: 'IT', status: 'ACTIVE' as const },
  { name: 'Albaicina Transfers', slug: 'albaicina-transfers', description: 'Airport and intercity transfers in Spain.', commissionBps: 1500, countryCode: 'ES', status: 'ACTIVE' as const },
];
