/**
 * Formatting helpers shared by server and client components.
 *
 * Everything here takes an optional locale. The UI speaks bare language tags
 * ("en", "zh") while `Intl` wants a regional tag, so `intlTag` bridges the two
 * — and falls back to the caller's own value so a fully-qualified tag still
 * works.
 */

import type { LocaleCode } from '@/lib/i18n/config';
import { translate } from '@/lib/i18n/dictionaries';

const INTL_TAGS: Record<string, string> = { en: 'en-US', zh: 'zh-CN' };

/** Maps a UI locale onto an `Intl` locale tag. */
export function intlTag(locale: LocaleCode | string = 'en'): string {
  return INTL_TAGS[locale] ?? locale;
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);

/** Money is always integer minor units; this is the only place it becomes text. */
export function formatMoney(cents: number, currency = 'USD', locale: LocaleCode | string = 'en'): string {
  const exponent = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  const amount = cents / Math.pow(10, exponent);
  try {
    return new Intl.NumberFormat(intlTag(locale), {
      style: 'currency',
      currency,
      currencyDisplay: exponent === 0 ? 'code' : 'symbol',
      maximumFractionDigits: exponent === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(exponent)}`;
  }
}

export function formatDate(date: string | Date, locale: LocaleCode | string = 'en'): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(intlTag(locale), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(value);
}

/**
 * `YYYY-MM-DD` shifted by whole days.
 *
 * Works in UTC on purpose. `new Date('2026-11-02')` parses as UTC midnight, but
 * `toISOString()` on a *local* midnight in a negative-offset zone lands on the
 * previous day — which would hand a guest a check-in one day earlier than the
 * one they picked. Same reasoning as `api/src/utils/date.ts`.
 */
export function addDaysIso(iso: string, days: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return iso;
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function formatDateTime(date: string | Date, locale: LocaleCode | string = 'en'): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(intlTag(locale), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

/** "in 3 days" / "tomorrow" / "2 months ago" - used on tickets and itineraries. */
export function relativeDay(
  date: string | Date,
  now = new Date(),
  locale: LocaleCode | string = 'en',
): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return '';

  const target = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  const t = (key: string, ...args: unknown[]) => translate(locale as LocaleCode, key, ...args);

  if (days === 0) return t('dates.today');
  if (days === 1) return t('dates.tomorrow');
  if (days === -1) return t('dates.yesterday');
  if (days > 1 && days < 7) return t('dates.inDays', days);
  if (days < -1 && days > -7) return t('dates.daysAgo', Math.abs(days));
  if (days > 0) return t('dates.inMonths', Math.round(days / 30));
  return t('dates.monthsAgo', Math.abs(Math.round(days / 30)));
}

export function discountPercent(currentCents: number, compareCents: number | null): number | null {
  if (!compareCents || compareCents <= currentCents) return null;
  return Math.round(((compareCents - currentCents) / compareCents) * 100);
}

/** Turns a ProductType enum value into shopper-facing copy. */
export const TYPE_LABELS: Record<string, string> = {
  ATTRACTION_TICKET: 'Attraction tickets',
  ACTIVITY: 'Activities',
  TOUR: 'Tours',
  DAY_TRIP: 'Day trips',
  PACKAGE: 'Packages',
  HOTEL_ROOM: 'Hotels',
  TRANSFER: 'Transfers',
  VEHICLE_RENTAL: 'Car rental',
  GUIDED_TOUR: 'Guided tours',
  RESTAURANT: 'Restaurants',
  CRUISE: 'Cruises',
  RENTAL_CAR: 'Car rental',
};

/** Maps an order status to shopper-facing copy in the caller's language. */
export function orderStatusLabel(status: string, locale: LocaleCode | string = 'en'): string {
  return translate(locale as LocaleCode, `orderStatus.${status}`);
}

/** Maps a ticket status to shopper-facing copy in the caller's language. */
export function ticketStatusLabel(status: string, locale: LocaleCode | string = 'en'): string {
  return translate(locale as LocaleCode, `ticketStatus.${status}`);
}

/** Maps an order status to the badge tone used across the UI. */
export function orderStatusTone(status: string): 'positive' | 'warning' | 'critical' | 'neutral' {
  switch (status) {
    case 'CONFIRMED':
    case 'COMPLETED':
      return 'positive';
    case 'PENDING_PAYMENT':
    case 'IN_PROGRESS':
      return 'warning';
    case 'CANCELLED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'EXPIRED':
    case 'FAILED':
      return 'critical';
    default:
      return 'neutral';
  }
}

export function ticketStatusTone(status: string): 'positive' | 'warning' | 'critical' | 'neutral' {
  switch (status) {
    case 'ISSUED':
      return 'positive';
    case 'PARTIALLY_REDEEMED':
      return 'warning';
    case 'REDEEMED':
    case 'VOID':
    case 'EXPIRED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Builds an ISO `YYYY-MM-DD` date string `days` from today. */
export function isoDateOffset(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function stars(rating: number): string {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return `${'★'.repeat(full)}${half ? '⯨' : ''}${'☆'.repeat(Math.max(0, 5 - full - (half ? 1 : 0)))}`;
}