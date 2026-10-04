import type { ProductType } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * Supply source abstraction
 * ---------------------------------------------------------------------------
 *
 * Same shape as `modules/payments/gateway.ts`: one interface, swappable
 * adapters, callers that do not care which is in use.
 *
 *   - `OpenDataSource`      imports identity + geometry from an open dataset
 *                           (OurAirports, Overture, OSM, Wikidata, ...).
 *   - `SyntheticSource`     derives prices and availability from the pricing and
 *                           inventory engines.
 *   - `PlatformSource`      the in-repo seed, for parity in dev.
 *
 * `booking/*` must not import this module. It reads the canonical tables
 * (`Product` / `TicketType` / `InventoryRecord`) only — the whole point of the
 * abstraction is that the booking path is identical whatever wrote the row.
 *
 * Identity is imported. Money is not.
 */

/** Where a row came from. Persisted, never inferred at read time. */
export type SupplyOrigin =
  | 'OPEN_DATASET'
  | 'SYNTHETIC'
  | 'CSV_IMPORT'
  | 'PLATFORM'
  | 'MERCHANT_FEED';

/** An external id is namespaced so two sources cannot collide on one row. */
export interface ExternalRef {
  sourceId: string;
  externalId: string;
}

export interface SupplyDestination {
  ref: ExternalRef;
  name: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface SupplyProduct {
  ref: ExternalRef;
  kind: ProductType;
  name: string;
  summary: string | null;
  /** e.g. `{ route: 'LHR→DXB→SIN' }` for a flight, `{ stars: 4 }` for a stay. */
  attributes: Record<string, string | number | null>;
}

export interface SupplyRate {
  productRef: ExternalRef;
  basePriceCents: number;
  currency: string;
  /** Basis points; markup applied by `modules/pricing`, not stored here. */
  commissionBps: number;
}

export interface SupplyAvailability {
  productRef: ExternalRef;
  /** `YYYY-MM-DD`. */
  serviceDate: string;
  /** Dimension within the date (room type, cabin, time slot); `""` when none. */
  dimensionKey: string;
  capacityTotal: number;
}

/**
 * One adapter per entry in `docs/supply-sources.md`.
 *
 * `listX` methods stream because a full import must not materialise a country in
 * memory. `getRates` / `getAvailability` may return `[]` — an open dataset does
 * not carry price or stock, and empty means "derive it", not "unavailable".
 */
export interface SupplySource {
  /** Matches the `id` column in `docs/supply-sources.md`. */
  readonly id: string;
  readonly origin: SupplyOrigin;
  /** SPDX-ish license string, persisted with the rows for attribution. */
  readonly license: string;

  listDestinations(): AsyncIterable<SupplyDestination>;
  listProducts(): AsyncIterable<SupplyProduct>;
  getRates(ref: ExternalRef): Promise<SupplyRate[]>;
  getAvailability(ref: ExternalRef, from: string, to: string): Promise<SupplyAvailability[]>;
}
