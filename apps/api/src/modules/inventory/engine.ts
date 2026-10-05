import { InventoryMode, InventoryStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { eachDay, formatServiceDate, minutesFromNow, toServiceDate } from '../../utils/date';
import { AppError } from '../../utils/errors';
import { generateToken } from '../../utils/ids';
import { emitInventoryAlert, type InventoryAlertLevel } from '../realtime/notify';

/**
 * ---------------------------------------------------------------------------
 * Inventory engine
 * ---------------------------------------------------------------------------
 *
 * Inventory lives in `InventoryRecord`, keyed by
 * (ticketType, serviceDate, timeSlot) with three counters:
 *
 *   capacityTotal  configured sellable units
 *   capacityHeld   units reserved by live carts/checkouts
 *   capacitySold   units consumed by confirmed orders
 *
 * Sellable = total - held - sold. Every mutation uses an optimistic
 * `version` guard inside a conditional update, so two concurrent checkouts
 * can never oversell the same seat. Holds are short lived (INVENTORY_HOLD_MINUTES)
 * and a reaper releases expired ones.
 */

export const TIME_SLOTS = [
  '00:00', '06:00', '08:00', '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '22:00',
] as const;

/**
 * Remaining units at which a slot starts being reported as scarce.
 *
 * Two thresholds, not one: "low" drives the marketing badge on a product page
 * ("selling fast"), while "critical" is what the operator console escalates.
 */
const LOW_STOCK_THRESHOLD = 5;
const CRITICAL_STOCK_THRESHOLD = 2;

/** Maps an available-unit count onto an alert level, or `null` when healthy. */
function alertLevel(remaining: number): InventoryAlertLevel | null {
  if (remaining <= 0) return 'SOLD_OUT';
  if (remaining <= CRITICAL_STOCK_THRESHOLD) return 'CRITICAL';
  if (remaining <= LOW_STOCK_THRESHOLD) return 'LOW';
  return null;
}

/**
 * Publishes a stock alert for one (ticket type, date, slot) triple.
 *
 * Callers that already know the remaining count pass `knownRemaining` so the
 * healthy case costs nothing — the authoritative read (and the join that yields
 * the product name) only happens when an alert is actually going to fire.
 *
 * Never throws: a realtime signal must not fail a booking.
 */
export async function emitStockAlert(params: {
  ticketTypeId: string;
  serviceDate: Date;
  timeSlot?: string | null;
  knownRemaining?: number;
}): Promise<void> {
  try {
    if (params.knownRemaining !== undefined && alertLevel(params.knownRemaining) === null) return;

    const record = await prisma.inventoryRecord.findUnique({
      where: {
        ticketTypeId_serviceDate_timeSlot: {
          ticketTypeId: params.ticketTypeId,
          serviceDate: params.serviceDate,
          timeSlot: params.timeSlot ?? '',
        },
      },
      include: {
        ticketType: {
          select: {
            productId: true,
            product: { select: { translations: { take: 1, select: { name: true } } } },
          },
        },
      },
    });
    if (!record) return;

    const remaining = Math.max(0, record.capacityTotal - record.capacityHeld - record.capacitySold);
    const level = alertLevel(remaining);
    if (!level) return;

    emitInventoryAlert({
      level,
      ticketTypeId: params.ticketTypeId,
      productId: record.ticketType.productId,
      productName: record.ticketType.product?.translations[0]?.name ?? null,
      serviceDate: formatServiceDate(record.serviceDate),
      timeSlot: record.timeSlot || null,
      remaining,
      capacityTotal: record.capacityTotal,
    });
  } catch (error) {
    logger.warn('inventory.alert_failed', { reason: (error as Error).message });
  }
}

export type HoldRequest = {
  ticketTypeId: string;
  userId?: string | null;
  cartId?: string | null;
  serviceDate: Date;
  timeSlot?: string | null;
  quantity: number;
};

export type HoldResult = {
  holdToken: string;
  inventoryRecordId: string;
  expiresAt: Date;
  quantity: number;
};

/** Makes sure an inventory row exists for the requested slot, creating it lazily. */
export async function ensureInventoryRecord(params: {
  ticketTypeId: string;
  serviceDate: Date;
  timeSlot?: string | null;
  defaultCapacity?: number;
}): Promise<InventoryRow> {
  const { ticketTypeId, serviceDate, timeSlot: rawSlot, defaultCapacity = 50 } = params;
  // Prisma cannot express a nullable field inside a composite unique key, so
  // "no time slot" is stored as the empty string rather than NULL.
  const timeSlot = rawSlot ?? '';

  const existing = await prisma.inventoryRecord.findUnique({
    where: { ticketTypeId_serviceDate_timeSlot: { ticketTypeId, serviceDate, timeSlot } },
  });
  if (existing) return existing;

  try {
    return await prisma.inventoryRecord.create({
      data: {
        ticketTypeId,
        serviceDate,
        timeSlot,
        capacityTotal: defaultCapacity,
        status: InventoryStatus.OPEN,
      },
    });
  } catch (error) {
    // Concurrent creation: re-read the winner's row.
    const raced = await prisma.inventoryRecord.findUnique({
      where: { ticketTypeId_serviceDate_timeSlot: { ticketTypeId, serviceDate, timeSlot } },
    });
    if (raced) return raced;
    throw error;
  }
}

/** Returns how many units are sellable right now. */
export function sellable(record: {
  capacityTotal: number;
  capacityHeld: number;
  capacitySold: number;
  status: InventoryStatus;
  inventoryMode: InventoryMode;
}): number {
  if (record.inventoryMode === InventoryMode.UNLIMITED) return Number.MAX_SAFE_INTEGER;
  if (record.status === InventoryStatus.CLOSED || record.status === InventoryStatus.SOLD_OUT) return 0;
  return Math.max(0, record.capacityTotal - record.capacityHeld - record.capacitySold);
}

type InventoryRow = {
  id: string;
  /** Carried so a multi-night failure can name the night that was short. */
  serviceDate: Date;
  capacityTotal: number;
  capacityHeld: number;
  capacitySold: number;
  status: InventoryStatus;
  version: number;
};

/** Atomically places a hold on inventory. Throws when unavailable. */
export async function placeHold(request: HoldRequest): Promise<HoldResult> {
  const { ticketTypeId, serviceDate, quantity, userId = null, cartId = null } = request;
  const timeSlot = request.timeSlot ?? '';
  if (quantity <= 0) throw AppError.badRequest('Hold quantity must be positive');

  const record = await ensureInventoryRecord({ ticketTypeId, serviceDate, timeSlot });
  const inventoryMode = await resolveInventoryMode(ticketTypeId);

  const available = sellable({ ...record, inventoryMode });
  if (available < quantity) {
    throw AppError.inventoryUnavailable(
      available === 0
        ? 'This date is sold out'
        : `Only ${available} spot${available === 1 ? '' : 's'} left on this date`,
      { available, requested: quantity },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Optimistic guard: only update when nobody else changed the counters.
    const result = await tx.inventoryRecord.updateMany({
      where: {
        id: record.id,
        version: record.version,
        status: InventoryStatus.OPEN,
        capacityHeld: { lt: record.capacityTotal },
      },
      data: {
        capacityHeld: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      // Someone else took the last seats between our read and write.
      throw AppError.inventoryUnavailable('This option just sold out, please pick another');
    }

    const expiresAt = minutesFromNow(15);
    const hold = await tx.inventoryHold.create({
      data: {
        holdToken: generateToken(18),
        inventoryRecordId: record.id,
        cartId,
        userId,
        quantity,
        expiresAt,
        status: 'ACTIVE',
      },
    });

    return hold;
  });

  logger.info('inventory.hold', {
    holdToken: updated.holdToken,
    ticketTypeId,
    quantity,
    expiresAt: updated.expiresAt.toISOString(),
  });

  // Realtime: `available - quantity` is the post-hold figure, so the alert
  // needs no extra read unless the slot is actually running out.
  void emitStockAlert({
    ticketTypeId,
    serviceDate,
    timeSlot,
    knownRemaining: available - quantity,
  });

  return {
    holdToken: updated.holdToken,
    inventoryRecordId: record.id,
    expiresAt: updated.expiresAt,
    quantity: updated.quantity,
  };
}

async function resolveInventoryMode(ticketTypeId: string): Promise<InventoryMode> {
  const ticketType = await prisma.ticketType.findUnique({
    where: { id: ticketTypeId },
    select: { inventoryMode: true },
  });
  return ticketType?.inventoryMode ?? InventoryMode.PER_DATE;
}

/**
 * Releases a hold and returns its units to the pool. Idempotent.
 *
 * Dispatches on the token: a stay's token resolves to an `InventoryHoldGroup`
 * and is fanned out across every night, anything else falls through to the
 * single-record path below. Doing the dispatch here rather than at each call
 * site is what lets a 3-night booking release all three nights without a single
 * existing caller changing — the booking engine already passes the same token
 * it received, so it has no way to know whether it is holding one night or ten.
 */
export async function releaseHold(holdToken: string): Promise<void> {
  const group = await prisma.inventoryHoldGroup.findUnique({
    where: { holdToken },
    select: { id: true },
  });
  if (group) return releaseHoldGroup(holdToken);

  const hold = await prisma.inventoryHold.findUnique({ where: { holdToken } });
  if (!hold || hold.status !== 'ACTIVE') return;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.inventoryHold.updateMany({
      where: { id: hold.id, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    // Only the transition that actually flipped ACTIVE -> RELEASED decrements.
    if (claimed.count === 1) {
      await tx.inventoryRecord.update({
        where: { id: hold.inventoryRecordId },
        data: {
          capacityHeld: { decrement: hold.quantity },
          version: { increment: 1 },
        },
      });
    }
  });

  logger.info('inventory.release', { holdToken, quantity: hold.quantity });
}

/**
 * Converts a hold into a sale: held -> sold. Called after payment capture.
 *
 * Dispatches to the group path for a stay, exactly as `releaseHold` does — see
 * the note there for why the branching lives at the entry point.
 */
export async function consumeHold(holdToken: string): Promise<void> {
  const group = await prisma.inventoryHoldGroup.findUnique({
    where: { holdToken },
    select: { id: true },
  });
  if (group) return consumeHoldGroup(holdToken);

  const hold = await prisma.inventoryHold.findUnique({
    where: { holdToken },
    include: {
      inventoryRecord: { select: { ticketTypeId: true, serviceDate: true, timeSlot: true } },
    },
  });
  if (!hold) throw AppError.inventoryExpired('Hold not found');
  if (hold.status === 'CONSUMED') return; // idempotent
  if (hold.status !== 'ACTIVE') throw AppError.inventoryExpired('Hold is no longer active');

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.inventoryHold.updateMany({
      where: { id: hold.id, status: 'ACTIVE' },
      data: { status: 'CONSUMED', releasedAt: new Date() },
    });
    if (claimed.count === 1) {
      // Move the units from `held` to `sold` in a single statement so the
      // sellable count never transiently changes.
      await tx.$executeRaw`
        UPDATE "InventoryRecord"
        SET "capacityHeld" = "capacityHeld" - ${hold.quantity},
            "capacitySold" = "capacitySold" + ${hold.quantity},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE id = ${hold.inventoryRecordId}
      `;
    }
  });

  logger.info('inventory.consume', { holdToken, quantity: hold.quantity });

  // Post-sale stock signal — this is the authoritative count, and it is what
  // turns a product page's "selling fast" badge on without any polling.
  await emitStockAlert({
    ticketTypeId: hold.inventoryRecord.ticketTypeId,
    serviceDate: hold.inventoryRecord.serviceDate,
    timeSlot: hold.inventoryRecord.timeSlot,
  });
}

/**
 * Sweeps holds whose TTL elapsed. Called on a timer and opportunistically
 * before availability queries, so abandoned carts release their seats.
 */
export async function releaseExpiredHolds(limit = 200): Promise<number> {
  const expired = await prisma.inventoryHold.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    select: { id: true, holdToken: true, quantity: true, inventoryRecordId: true },
    take: limit,
  });

  let released = 0;
  for (const hold of expired) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.inventoryHold.updateMany({
        where: { id: hold.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED', releasedAt: new Date() },
      });
      if (claimed.count === 1) {
        await tx.inventoryRecord.update({
          where: { id: hold.inventoryRecordId },
          data: {
            capacityHeld: { decrement: hold.quantity },
            version: { increment: 1 },
          },
        });
      }
    });
    released += 1;
  }

  // Sweep the stay groups themselves.
  //
  // The loop above expires child holds, which returns the rooms — so capacity is
  // correct either way — but it leaves `InventoryHoldGroup.status` at ACTIVE
  // forever. Verified against live data: a 3-night group whose three children had
  // all expired still read ACTIVE with zero active children. Anything that reads
  // groups (the TTL filter, an operator view) would then count it as a live
  // claim. The same "writer without a reader" shape as the Phase 0 facets.
  const expiredGroups = await prisma.inventoryHoldGroup.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    select: { id: true },
    take: limit,
  });
  let releasedGroups = 0;
  for (const group of expiredGroups) {
    const claimed = await prisma.inventoryHoldGroup.updateMany({
      where: { id: group.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED', releasedAt: new Date() },
    });
    if (claimed.count === 1) releasedGroups += 1;
  }

  if (released > 0 || releasedGroups > 0) {
    logger.info('inventory.expiry_sweep', { released, releasedGroups });
  }
  return released + releasedGroups;
}

/** Cancels a booking and returns sold units back to the pool. */
export async function returnSoldUnits(
  tx: Prisma.TransactionClient,
  ticketTypeId: string,
  serviceDate: Date,
  timeSlot: string | null,
  quantity: number,
): Promise<void> {
  const slot = timeSlot ?? '';
  const record = await tx.inventoryRecord.findUnique({
    where: { ticketTypeId_serviceDate_timeSlot: { ticketTypeId, serviceDate, timeSlot: slot } },
  });
  if (!record) return;

  await tx.inventoryRecord.update({
    where: { id: record.id },
    data: {
      capacitySold: { decrement: quantity },
      version: { increment: 1 },
    },
  });

  // Recompute status so a sold-out day reopens once capacity frees up.
  const remaining = record.capacityTotal - record.capacityHeld - (record.capacitySold - quantity);
  if (remaining > 0 && record.status === InventoryStatus.SOLD_OUT) {
    await tx.inventoryRecord.update({
      where: { id: record.id },
      data: { status: InventoryStatus.OPEN },
    });
  }
}

/** Rolls a day to SOLD_OUT once no capacity remains. */
export async function markSoldOutIfEmpty(
  tx: Prisma.TransactionClient,
  inventoryRecordId: string,
): Promise<void> {
  const record = await tx.inventoryRecord.findUnique({ where: { id: inventoryRecordId } });
  if (!record) return;
  if (record.capacityTotal - record.capacityHeld - record.capacitySold <= 0) {
    await tx.inventoryRecord.update({
      where: { id: inventoryRecordId },
      data: { status: InventoryStatus.SOLD_OUT },
    });
  }
}

/**
 * Availability across a date window, used by the calendar picker on the
 * detail page. Returns a status and the cheapest price per day.
 *
 * `availableQty` is the sum across ticket types, which is what a browser wants
 * for "how busy is this day" — but it must not be read as "this many of *any*
 * option can be booked". Summing hides exhaustion in one option: a hotel with
 * capacities 18 / 6 / 2 whose cheap type is sold out still totals 26, so the
 * calendar says AVAILABLE, the customer picks that option, and checkout answers
 * INVENTORY_UNAVAILABLE. `byTicketType` carries the per-option truth so a caller
 * that is about to book a *specific* option can check it first.
 */
export async function getAvailabilityCalendar(params: {
  productId: string;
  from: Date;
  to: Date;
}): Promise<{
  date: string;
  status: string;
  availableQty: number;
  minPriceCents: number;
  byTicketType: { ticketTypeId: string; available: number }[];
}[]> {
  await releaseExpiredHolds(50);

  const ticketTypes = await prisma.ticketType.findMany({
    where: { productId: params.productId, active: true },
    select: { id: true, basePriceCents: true, inventoryMode: true },
  });
  if (ticketTypes.length === 0) return [];

  const records = await prisma.inventoryRecord.findMany({
    where: {
      ticketTypeId: { in: ticketTypes.map((t) => t.id) },
      serviceDate: { gte: params.from, lte: params.to },
    },
  });

  const priceByType = new Map(ticketTypes.map((t) => [t.id, t.basePriceCents]));
  const byDate = new Map<
    string,
    { available: number; minPrice: number; perType: Map<string, number> }
  >();

  for (const record of records) {
    if (record.status === InventoryStatus.CLOSED) continue;

    const available = sellable({ ...record, inventoryMode: InventoryMode.PER_DATE });

    const key = formatServiceDate(record.serviceDate);
    const existing = byDate.get(key);
    const price = priceByType.get(record.ticketTypeId) ?? 0;

    if (existing) {
      // A CLOSED or exhausted option contributes 0 rather than being skipped:
      // skipping it would drop the type out of `byTicketType` entirely, and a
      // caller checking "can I book type X on this date" would read a missing
      // entry as "unknown" instead of "no".
      existing.perType.set(record.ticketTypeId, available);
      existing.available += available;
      existing.minPrice = Math.min(existing.minPrice, price);
    } else {
      byDate.set(key, {
        available,
        minPrice: price,
        perType: new Map([[record.ticketTypeId, available]]),
      });
    }
  }

  return [...byDate.entries()]
    .map(([date, value]) => ({
      date,
      status: value.available >= 10 ? 'AVAILABLE' : 'LIMITED',
      availableQty: value.available,
      minPriceCents: value.minPrice,
      byTicketType: [...value.perType.entries()].map(([ticketTypeId, available]) => ({
        ticketTypeId,
        available,
      })),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Seeds inventory rows for a window (used by admin tooling and the seeder). */
export async function seedInventoryWindow(params: {
  ticketTypeId: string;
  from: Date;
  to: Date;
  capacity: number;
  timeSlots?: string[];
  netPriceCents?: number;
}): Promise<number> {
  const dates: Date[] = [];
  let cursor = toServiceDate(params.from);
  const end = toServiceDate(params.to);
  while (cursor.getTime() <= end.getTime() && dates.length < 400) {
    dates.push(cursor);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  const slots = params.timeSlots && params.timeSlots.length ? params.timeSlots : [''];
  let created = 0;

  for (const date of dates) {
    for (const slot of slots) {
      const data = {
        ticketTypeId: params.ticketTypeId,
        serviceDate: date,
        timeSlot: slot,
        capacityTotal: params.capacity,
        netPriceCents: params.netPriceCents,
        status: InventoryStatus.OPEN,
      };
      const result = await prisma.inventoryRecord.upsert({
        where: { ticketTypeId_serviceDate_timeSlot: { ticketTypeId: params.ticketTypeId, serviceDate: date, timeSlot: slot } },
        create: data,
        update: { capacityTotal: params.capacity, netPriceCents: params.netPriceCents },
      });
      if (result) created += 1;
    }
  }

  return created;
}

// ===========================================================================
// Multi-night stays
// ===========================================================================

/** Hard ceiling on a single stay, so a bad range cannot ask for 10^6 holds. */
const MAX_STAY_NIGHTS = 30;

/** A date range plus the rooms booked into it. */
export type StayHoldRequest = {
  ticketTypeId: string;
  userId?: string | null;
  cartId?: string | null;
  /** First night. Inclusive. */
  checkIn: Date;
  /** Departure morning. Exclusive — a 3-night stay checks out on checkIn + 3. */
  checkOut: Date;
  /** Rooms (not guests). Each room needs one hold on every night. */
  quantity: number;
  /** Room type within `ProductStay.roomTypes`; carried for traceability only. */
  roomTypeCode?: string | null;
};

export type StayHoldResult = {
  holdToken: string;
  groupId: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  quantity: number;
  expiresAt: Date;
  inventoryRecordIds: string[];
};

/**
 * Validates a stay range and returns the individual nights it occupies.
 *
 * Checkout is exclusive, matching how every hotel quotes "3 nights" — a guest
 * arriving Monday and leaving Thursday booked 3 nights, not 4. `eachDay` is
 * therefore given the last *occupied* night, not the checkout date.
 */
export function stayNights(checkIn: Date, checkOut: Date): Date[] {
  const from = toServiceDate(checkIn);
  const to = toServiceDate(checkOut);
  const nights = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  if (!Number.isFinite(nights) || nights <= 0) {
    throw AppError.badRequest('Check-out must be at least one night after check-in');
  }
  if (nights > MAX_STAY_NIGHTS) {
    throw AppError.badRequest(`A single stay cannot exceed ${MAX_STAY_NIGHTS} nights`);
  }

  // Last occupied night is the day before checkout.
  const lastNight = new Date(from.getTime() + (nights - 1) * 86_400_000);
  return eachDay(from, lastNight);
}

/**
 * Enforces `minNights` / `maxNights` from `ProductStay.policies`.
 *
 * Called before any hold is placed. Doing it afterwards would mean rolling back
 * holds we just took, and a partial rollback that fails leaves the property with
 * a phantom block on a real night.
 */
export function assertStayLengthAllowed(nights: number, policies: unknown): void {
  if (!policies || typeof policies !== 'object') return;
  const { minNights, maxNights } = policies as { minNights?: number; maxNights?: number };

  if (typeof minNights === 'number' && nights < minNights) {
    throw AppError.badRequest(`This property requires a minimum stay of ${minNights} nights`);
  }
  if (typeof maxNights === 'number' && nights > maxNights) {
    throw AppError.badRequest(`This property allows at most ${maxNights} nights per stay`);
  }
}

/**
 * Holds every night of a stay, or none of them.
 *
 * All-or-nothing is the whole point. A 3-night booking that quietly blocks only
 * nights 1 and 3 because night 2 sold out is worse than a clear failure: the
 * guest thinks they have a room, and the property has a phantom reservation on
 * two dates. So availability is checked for every night first, then all holds are
 * written inside one transaction — any optimistic-lock miss aborts the set and
 * the transaction rolls back, leaving no partial state.
 */
export async function placeStayHold(request: StayHoldRequest): Promise<StayHoldResult> {
  const { ticketTypeId, quantity, userId = null, cartId = null } = request;
  if (quantity <= 0) throw AppError.badRequest('Room quantity must be positive');

  const dates = stayNights(request.checkIn, request.checkOut);
  const inventoryMode = await resolveInventoryMode(ticketTypeId);

  // Create any missing night rows before the transaction, so the transaction
  // only ever performs the guarded updates. `ensureInventoryRecord` is itself
  // race-safe (it re-reads on a unique violation).
  const records: InventoryRow[] = [];
  for (const date of dates) {
    records.push(await ensureInventoryRecord({ ticketTypeId, serviceDate: date, timeSlot: '' }));
  }

  // Pre-flight: identify the short nights before taking anything, so the error
  // names the actual date rather than failing on an opaque lock miss.
  for (const record of records) {
    const available = sellable({ ...record, inventoryMode });
    if (available < quantity) {
      throw AppError.inventoryUnavailable(
        available === 0
          ? `Sold out on ${formatServiceDate(record.serviceDate)}`
          : `Only ${available} room${available === 1 ? '' : 's'} left on ${formatServiceDate(record.serviceDate)}`,
        { date: formatServiceDate(record.serviceDate), available, requested: quantity },
      );
    }
  }

  const holdToken = generateToken(18);
  const expiresAt = minutesFromNow(15);

  const { group, holds } = await prisma.$transaction(async (tx) => {
    const createdGroup = await tx.inventoryHoldGroup.create({
      data: {
        holdToken,
        cartId,
        userId,
        productId: (await tx.ticketType.findUniqueOrThrow({
          where: { id: ticketTypeId },
          select: { productId: true },
        })).productId,
        checkInDate: dates[0],
        // The departure morning, not the last occupied night. `dates` ends one
        // day earlier because checkout is exclusive, so persisting
        // `dates[n-1]` here would record a guest as departing a day before they
        // actually leave — and any later `differenceInDays(checkOut, checkIn)`
        // read back off this row would report one night fewer than booked.
        checkOutDate: toServiceDate(request.checkOut),
        nights: dates.length,
        quantity,
        status: 'ACTIVE',
        expiresAt,
      },
    });

    const createdHolds = [];
    for (const record of records) {
      // Same optimistic guard as `placeHold`: only claim when nobody else moved
      // the counters since we read them.
      const claimed = await tx.inventoryRecord.updateMany({
        where: {
          id: record.id,
          version: record.version,
          status: InventoryStatus.OPEN,
        },
        data: {
          capacityHeld: { increment: quantity },
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        // Another checkout won this night between our read and our write. Throw
        // so the transaction discards every hold placed so far.
        throw AppError.inventoryUnavailable(
          `Only ${formatServiceDate(record.serviceDate)} was just taken — please pick another room`,
          { date: formatServiceDate(record.serviceDate) },
        );
      }

      createdHolds.push(
        await tx.inventoryHold.create({
          data: {
            holdToken: generateToken(18),
            groupId: createdGroup.id,
            cartId,
            userId,
            inventoryRecordId: record.id,
            quantity,
            status: 'ACTIVE',
            expiresAt,
          },
        }),
      );
    }

    return { group: createdGroup, holds: createdHolds };
  });

  logger.info('inventory.stay_hold', {
    holdToken,
    groupId: group.id,
    nights: dates.length,
    quantity,
    expiresAt: expiresAt.toISOString(),
  });

  // Realtime signals are best-effort and must never fail a booking, so they go
  // out after the transaction commits rather than inside it.
  for (const record of records) {
    void emitStockAlert({
      ticketTypeId,
      serviceDate: record.serviceDate,
      timeSlot: '',
      knownRemaining: sellable({ ...record, inventoryMode }) - quantity,
    });
  }

  return {
    holdToken,
    groupId: group.id,
    checkIn: dates[0],
    checkOut: dates[dates.length - 1],
    nights: dates.length,
    quantity,
    expiresAt,
    inventoryRecordIds: holds.map((h) => h.inventoryRecordId),
  };
}

/**
 * Releases every night of a stay.
 *
 * Safe to call for a single-date hold too: the group is optional, and a token
 * with no group falls through to the original single-record path. That keeps
 * `releaseHold` correct for both shapes without the caller knowing which it has.
 */
/**
 * Releases every night of a stay.
 *
 * Internal: callers reach this through `releaseHold`, which dispatches here when
 * the token resolves to a group. Exported for direct use only where a caller
 * already knows it holds a group token.
 */
export async function releaseHoldGroup(holdToken: string): Promise<void> {
  const group = await prisma.inventoryHoldGroup.findUnique({ where: { holdToken } });
  if (!group) return releaseHold(holdToken);
  if (group.status !== 'ACTIVE') return;

  await prisma.$transaction(async (tx) => {
    // Only the ACTIVE -> RELEASED transition decrements, so a concurrent or
    // repeated release cannot double-return the rooms.
    const claimed = await tx.inventoryHoldGroup.updateMany({
      where: { id: group.id, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    const children = await tx.inventoryHold.findMany({
      where: { groupId: group.id, status: 'ACTIVE' },
    });
    await tx.inventoryHold.updateMany({
      where: { id: { in: children.map((c) => c.id) } },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    for (const child of children) {
      await tx.inventoryRecord.update({
        where: { id: child.inventoryRecordId },
        data: {
          capacityHeld: { decrement: child.quantity },
          version: { increment: 1 },
        },
      });
    }
  });

  logger.info('inventory.stay_release', { holdToken, nights: group.nights, quantity: group.quantity });
}

/** Consumes every night of a stay: held -> sold, in one statement per night. */
export async function consumeHoldGroup(holdToken: string): Promise<void> {
  const group = await prisma.inventoryHoldGroup.findUnique({
    where: { holdToken },
    include: { holds: { include: { inventoryRecord: true } } },
  });
  if (!group) return consumeHold(holdToken);
  if (group.status === 'CONSUMED') return; // idempotent
  if (group.status !== 'ACTIVE') throw AppError.inventoryExpired('Hold is no longer active');

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.inventoryHoldGroup.updateMany({
      where: { id: group.id, status: 'ACTIVE' },
      data: { status: 'CONSUMED', releasedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    await tx.inventoryHold.updateMany({
      where: { groupId: group.id, status: 'ACTIVE' },
      data: { status: 'CONSUMED', releasedAt: new Date() },
    });

    // held -> sold in one statement each, so no night's sellable count
    // transiently appears higher than it is.
    for (const child of group.holds) {
      await tx.$executeRaw`
        UPDATE "InventoryRecord"
        SET "capacityHeld" = "capacityHeld" - ${child.quantity},
            "capacitySold" = "capacitySold" + ${child.quantity},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE id = ${child.inventoryRecordId}
      `;
    }
  });

  logger.info('inventory.stay_consume', { holdToken, nights: group.nights, quantity: group.quantity });
}