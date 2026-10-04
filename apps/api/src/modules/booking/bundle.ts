/**
 * Bundle expansion.
 *
 * A `PACKAGE` product is not sold as itself — it is a shopping list. Buying it
 * means buying every component, on the right dates, at one price. This module
 * turns that list into concrete cart lines so the existing booking engine never
 * learns what a bundle is: it receives N ordinary lines and does what it already
 * does for any multi-line order, including rolling back every hold if any one of
 * them fails.
 *
 * Why expansion at the cart rather than a second checkout path
 * -----------------------------------------------------------
 * Atomicity is the whole promise of a package, and atomicity is something the
 * booking engine already provides for multi-line orders: it holds every line,
 * and on any failure releases every hold it took. A separate "bundle checkout"
 * would mean a second place for that invariant to rot.
 *
 * Components may be optional (`required: false`). An optional component that is
 * sold out does not fail the bundle — it is dropped, and the remaining lines
 * still book. A required component that is sold out fails the whole thing,
 * because a package that silently omits the flight is not the product that was
 * advertised.
 *
 * Dates
 * -----
 * A bundle has one arrival date. Each component declares its own offset and
 * length, so "3 nights' hotel + airport transfer on the arrival day" is
 * expressible: the transfer is `FLIGHT` with `startOffsetDays: 0`, the hotel is
 * `HOTEL_ROOM` with `stayNights: 3`.
 */
import type { PrismaClient } from '@prisma/client';
import { addDays } from '../../utils/date';

export type BundleComponentSpec = {
  ticketTypeId: string;
  kind: string;
  label: string;
  position: number;
  required: boolean;
  quantity: number;
  stayNights: number | null;
  startOffsetDays: number | null;
};

/** One concrete cart line derived from a bundle component. */
export type ExpandedBundleLine = {
  ticketTypeId: string;
  /** Nights occupied. 1 for anything that is not a stay. */
  nights: number;
  serviceDate: Date;
  checkOutDate: Date | null;
  quantity: number;
  label: string;
  kind: string;
};

export type ExpandBundleInput = {
  bundleProductId: string;
  /** First night / departure date of the package. */
  startDate: Date;
  /** Rooms or booking units of the package itself. */
  quantity: number;
  /** Ticket types that must be checked for availability, keyed by id. */
  availableTicketTypeIds: ReadonlySet<string>;
};

export type ExpandBundleResult = {
  lines: ExpandedBundleLine[];
  /** Optional components skipped because their option is not bookable. */
  droppedOptional: string[];
};

/**
 * Turns a bundle into cart lines, skipping unsellable optional components.
 *
 * The caller is responsible for having already loaded the bundle and decided the
 * product is a package; this function only reads `components`.
 *
 * A required component that is missing throws. That is deliberately a hard
 * failure even when the rest of the package could still be booked — a traveller
 * who paid for a flight-and-hotel package and received a hotel only has been
 * short-changed, and failing at the cart is far kinder than failing at the gate.
 */
export function expandBundle(
  components: readonly BundleComponentSpec[],
  input: ExpandBundleInput,
): ExpandBundleResult {
  const lines: ExpandedBundleLine[] = [];
  const droppedOptional: string[] = [];

  // Components are ordered so a multi-line cart reads in itinerary order.
  const ordered = [...components].sort((a, b) => a.position - b.position);

  for (const component of ordered) {
    const sellable = input.availableTicketTypeIds.has(component.ticketTypeId);
    if (!sellable) {
      if (component.required) {
        throw new Error(`Bundle component "${component.label}" is not bookable`);
      }
      droppedOptional.push(component.label);
      continue;
    }

    const startDate = addDays(input.startDate, component.startOffsetDays ?? 0);

    // `stayNights` is authored per component. A hotel component that says 3
    // occupies three nights; anything else occupies one date. The component
    // quantity is per package unit, so a 2-room package of a 1-room component
    // carries 2.
    const nights = component.stayNights && component.stayNights > 0 ? component.stayNights : 1;

    lines.push({
      ticketTypeId: component.ticketTypeId,
      nights,
      serviceDate: startDate,
      // Exclusive: a 3-night stay starting on the 2nd checks out on the 5th.
      checkOutDate: nights > 1 ? addDays(startDate, nights) : null,
      quantity: component.quantity * input.quantity,
      label: component.label,
      kind: component.kind,
    });
  }

  if (lines.length === 0) {
    throw new Error('Bundle has no bookable components');
  }

  return { lines, droppedOptional };
}

/**
 * Reads a bundle's components as plain specs.
 *
 * Split out so the expansion logic above stays a pure function — it is the part
 * worth unit-testing, and it should not need a database to exercise.
 */
export async function loadBundleComponents(
  prisma: PrismaClient,
  bundleProductId: string,
): Promise<BundleComponentSpec[]> {
  const bundle = await prisma.productBundle.findUnique({
    where: { productId: bundleProductId },
    select: {
      components: {
        select: {
          ticketTypeId: true,
          kind: true,
          label: true,
          position: true,
          required: true,
          quantity: true,
          stayNights: true,
          startOffsetDays: true,
        },
      },
    },
  });

  return bundle?.components ?? [];
}