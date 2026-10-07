'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, ApiError, type ProductDetail } from '@/lib/api';
import { addDaysIso, formatDate, formatMoney, relativeDay } from '@/lib/format';
import { readCartToken, readToken, saveCartToken } from '@/lib/session';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * The sticky booking panel. Everything a shopper needs to commit is here:
 * date, option, quantity, live price breakdown and the checkout CTA.
 *
 * State is entirely client-side and the URL is kept in sync so the choice
 * survives a refresh and is shareable.
 */
export function BookingPanel({
  product,
  selectedDate,
  quantity: initialQuantity,
  lowestPrice,
  locale,
}: {
  product: ProductDetail;
  selectedDate: string;
  quantity: number;
  lowestPrice: number | null;
  locale: LocaleCode;
}) {
  const router = useRouter();
  const t = createTranslator(locale);

  const [ticketTypeId, setTicketTypeId] = useState(product.ticketTypes[0]?.id ?? '');
  const [quantity, setQuantity] = useState(Math.min(Math.max(1, initialQuantity), product.ticketTypes[0]?.maxPerOrder ?? 1));
  const [coupon, setCoupon] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cartMessage, setCartMessage] = useState<string | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);

  /**
   * A stay needs a departure date; a ticket does not. `isStay` is read off the
   * product type rather than a feature flag so a new multi-night category does
   * not also need a switch flipped here.
   */
  const isStay = product.type === 'HOTEL_ROOM' || product.type === 'CRUISE';
  const [checkOutDate, setCheckOutDate] = useState('');

  /**
   * Nights between arrival and departure. Checkout is exclusive — arriving
   * Monday and leaving Thursday is 3 nights — so this is a plain day difference,
   * and a departure on or before arrival yields 0, which hides the field's error
   * rather than sending a range the server would reject.
   */
  const nights = useMemo(() => {
    if (!isStay || !checkOutDate) return 0;
    const ms = new Date(`${checkOutDate}T00:00:00Z`).getTime() - new Date(`${selectedDate}T00:00:00Z`).getTime();
    return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
  }, [isStay, checkOutDate, selectedDate]);

  const selected = product.ticketTypes.find((t) => t.id === ticketTypeId) ?? product.ticketTypes[0];

  // The server is the source of truth for money. It returns authoritative
  // per-unit figures for the requested quantity, so scale those linearly and
  // let checkout re-price server-side before charging anything.
  const priced = useMemo(() => {
    if (!selected) return null;
    // A stay is priced per room per night. `unitNights` is 1 for a ticket, so
    // this reduces to the original quantity-only arithmetic.
    const unitNights = isStay && nights > 0 ? nights : 1;
    return {
      unitNights,
      lineTotal: selected.totalPerUnitCents * quantity * unitNights,
      discountTotal: selected.discountCents * quantity * unitNights,
    };
  }, [selected, quantity, isStay, nights]);

  if (!selected || !priced) {
    return (
      <aside className="booking-panel">
        <p className="muted">{t('product.notBookable')}</p>
      </aside>
    );
  }

  const maxQty = selected.maxPerOrder;

  function changeQuantity(next: number) {
    const clamped = Math.min(Math.max(selected.minPerOrder, next), maxQty);
    setQuantity(clamped);
  }

  function updateUrl(nextTicketTypeId: string, nextQuantity: number) {
    const params = new URLSearchParams({ date: selectedDate, quantity: String(nextQuantity) });
    router.replace(`/products/${product.slug}?${params.toString()}`, { scroll: false });
  }

  async function checkout() {
    setSubmitting(true);
    const params = new URLSearchParams({
      // `slug` is required, not decorative: `/checkout` reads it to identify the
      // product and redirects to `/search` when it is absent. It was missing
      // here, so the primary "Reserve & continue to payment" button silently
      // discarded the shopper's date, ticket type and quantity and dropped them
      // back on search.
      slug: product.slug,
      ticketTypeId: selected.id,
      date: selectedDate,
      quantity: String(quantity),
    });
    if (coupon.trim()) params.set('coupon', coupon.trim());
    router.push(`/checkout?${params.toString()}`);
  }

  async function addToCart() {
    setSubmitting(true);
    setCartError(null);
    setCartMessage(null);
    try {
      const token = readToken();
      let cartToken = readCartToken();
      const cart = await api.cart(token, cartToken, locale);
      if (cart.guestToken) {
        cartToken = cart.guestToken;
        saveCartToken(cartToken);
      }
      await api.addCartItem(
        {
          ticketTypeId: selected.id,
          serviceDate: selectedDate,
          // Only send a range the user has actually made valid; a zero-night or
          // inverted range is dropped so the line books as a single night rather
          // than being rejected outright.
          checkOutDate: isStay && nights > 0 ? checkOutDate : undefined,
          quantity,
        },
        token,
        cartToken,
        locale,
      );
      setCartMessage(t('product.addedToCart'));
    } catch (caught) {
      setCartError(caught instanceof ApiError ? caught.message : t('cart.couldNotLoad'));
    } finally {
      setSubmitting(false);
    }
  }

  const offPercent =
    selected.compareAtPriceCents && selected.compareAtPriceCents > selected.totalPerUnitCents
      ? Math.round(
          ((selected.compareAtPriceCents - selected.totalPerUnitCents) / selected.compareAtPriceCents) * 100,
        )
      : null;

  return (
    <aside className="booking-panel">
      {/* Price anchor */}
      <div>
        <div className="row wrap" style={{ gap: 'var(--sp-2)', marginBottom: 4 }}>
          {offPercent && (
            <span className="badge badge-accent">{t('product.offToday', offPercent)}</span>
          )}
          {lowestPrice !== null && lowestPrice < selected.totalPerUnitCents && (
            <span className="badge badge-positive">{t('product.lowestPrice')}</span>
          )}
        </div>
        <div className="row" style={{ alignItems: 'baseline', gap: 'var(--sp-2)' }}>
          <span className="price-now" style={{ fontSize: 26 }}>
            {formatMoney(selected.totalPerUnitCents, selected.currency)}
          </span>
          {selected.compareAtPriceCents && offPercent && (
            <span className="price-was">{formatMoney(selected.compareAtPriceCents, selected.currency)}</span>
          )}
        </div>
        <div className="tiny subtle">{t('product.perPersonInclTax')}</div>
      </div>

      {/* Date summary */}
      <div className="panel stack-sm" style={{ padding: 'var(--sp-3)' }}>
        <div className="row-between">
          <span className="small muted">{t('product.dateLabel')}</span>
          <a
            href={`/products/${product.slug}?quantity=${quantity}`}
            className="small bold"
            style={{ color: 'var(--brand-600)' }}
          >
            {formatDate(selectedDate)} · {relativeDay(selectedDate)}
          </a>
        </div>
        {isStay && (
          <label className="stack-sm" style={{ display: 'block' }}>
            <span className="small muted">{t('product.checkOutLabel')}</span>
            <input
              type="date"
              className="input"
              value={checkOutDate}
              // Arrival is the earliest sensible departure: a same-day or earlier
              // checkout has no nights in it.
              min={addDaysIso(selectedDate, 1)}
              onChange={(event) => setCheckOutDate(event.target.value)}
            />
            {checkOutDate && nights <= 0 && (
              <span className="tiny" style={{ color: 'var(--danger-600)' }}>
                {t('product.checkOutAfterCheckIn')}
              </span>
            )}
            {nights > 0 && (
              <span className="tiny subtle">
                {nights} {t('product.nights')} · {formatDate(selectedDate)} – {formatDate(checkOutDate)}
              </span>
            )}
          </label>
        )}
        {product.destination && (
          <div className="row-between">
            <span className="small muted">{t('product.locationLabel')}</span>
            <span className="small bold">{product.destination.name}</span>
          </div>
        )}
      </div>

      {/* Options */}
      <div className="stack-sm">
        <span className="label">{t('product.chooseOption')}</span>
        {product.ticketTypes.map((ticketType) => (
          <label
            key={ticketType.id}
            className={`ticket-option ${ticketType.id === selected.id ? 'selected' : ''}`}
            onClick={() => {
              setTicketTypeId(ticketType.id);
              updateUrl(ticketType.id, Math.min(quantity, ticketType.maxPerOrder));
            }}
          >
            <input
              type="radio"
              name="ticketType"
              value={ticketType.id}
              checked={ticketType.id === selected.id}
              onChange={() => {
                setTicketTypeId(ticketType.id);
                updateUrl(ticketType.id, Math.min(quantity, ticketType.maxPerOrder));
              }}
              style={{ pointerEvents: 'none' }}
            />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small bold">{ticketType.name}</div>
              {ticketType.description && <div className="tiny subtle">{ticketType.description}</div>}
              {ticketType.discountCents > 0 && (
                <div className="tiny" style={{ color: 'var(--success-600)', fontWeight: 600 }}>
                  {t('product.saveWithOption', formatMoney(ticketType.discountCents, ticketType.currency))}
                </div>
              )}
            </div>
            <div className="right nowrap">
              <div className="bold small">{formatMoney(ticketType.totalPerUnitCents, ticketType.currency)}</div>
              <div className="tiny subtle">{t('common.perPerson')}</div>
            </div>
          </label>
        ))}
      </div>

      {/* Quantity */}
      <div className="row-between">
        <span className="label">
          {selected.minPerOrder > 1
            ? t('product.guestsMin', selected.minPerOrder)
            : t('product.guestsLabel')}
        </span>
        <div className="qty-control">
          <button
            type="button"
            onClick={() => {
              changeQuantity(quantity - 1);
              updateUrl(selected.id, Math.max(selected.minPerOrder, quantity - 1));
            }}
            disabled={quantity <= selected.minPerOrder}
            aria-label={t('product.decreaseQty')}
          >
            −
          </button>
          <span>{quantity}</span>
          <button
            type="button"
            onClick={() => {
              changeQuantity(quantity + 1);
              updateUrl(selected.id, Math.min(maxQty, quantity + 1));
            }}
            disabled={quantity >= maxQty}
            aria-label={t('product.increaseQty')}
          >
            +
          </button>
        </div>
      </div>

      {/* Discount codes applied at checkout */}
      <div className="field">
        <label htmlFor="coupon" className="label">
          {t('product.promoCode')}
        </label>
        <input
          id="coupon"
          className="input"
          placeholder={t('product.haveACode')}
          value={coupon}
          onChange={(event) => setCoupon(event.target.value)}
        />
      </div>

      {/* Price breakdown */}
      <div className="panel">
        <div className="price-row">
          <span className="label">
            {formatMoney(selected.totalPerUnitCents, selected.currency)} × {quantity}
          </span>
          <span className="bold">{formatMoney(priced.lineTotal, selected.currency)}</span>
        </div>
        {priced.discountTotal > 0 && (
          <div className="price-row">
            <span className="label" style={{ color: 'var(--success-600)' }}>
              {t('product.promotionSavings')}
            </span>
            <span style={{ color: 'var(--success-600)', fontWeight: 600 }}>
              −{formatMoney(priced.discountTotal, selected.currency)}
            </span>
          </div>
        )}
        <div className="price-row total">
          <span>{t('product.total')}</span>
          <span>{formatMoney(priced.lineTotal, selected.currency)}</span>
        </div>
      </div>

      <button className="btn btn-accent btn-lg btn-block" onClick={checkout} disabled={submitting}>
        {submitting ? t('product.preparingCheckout') : t('product.reserveAndPay')}
      </button>

      <button className="btn btn-secondary btn-block" onClick={addToCart} disabled={submitting}>
        {t('product.addToCart')}
      </button>
      {cartMessage && (
        <p className="tiny center" role="status">
          {cartMessage} · <a href="/cart">{t('nav.cart')}</a>
        </p>
      )}
      {cartError && <p className="form-error" role="alert">{cartError}</p>}

      <p className="tiny subtle center">
        {t('product.notChargedYet', product.cancellationPolicy?.freeCancelHours ?? 24)}
      </p>

      {/* Applied pricing rules — transparency about why the price moved */}
      {selected.appliedRules.length > 0 && (
        <div className="stack-sm">
          <span className="label">{t('product.priceAdjustments')}</span>
          {selected.appliedRules.map((rule) => (
            <div key={rule.ruleId} className="row-between tiny">
              <span className="muted truncate">{rule.name}</span>
              <span className="nowrap" style={{ color: rule.deltaCents < 0 ? 'var(--success-600)' : 'var(--text-muted)' }}>
                {rule.deltaCents < 0 ? '−' : '+'}
                {formatMoney(Math.abs(rule.deltaCents), selected.currency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}