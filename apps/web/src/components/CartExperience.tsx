'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Cart, type CheckoutResult } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { clearCartToken, readCartToken, readToken, saveCartToken } from '@/lib/session';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

async function fetchCart(locale: LocaleCode): Promise<Cart> {
  const token = readToken();
  let cartToken = readCartToken();
  try {
    const cart = await api.cart(token, cartToken, locale);
    if (cart.guestToken) {
      cartToken = cart.guestToken;
      saveCartToken(cartToken);
    }
    return cart;
  } catch (caught) {
    if (!(caught instanceof ApiError) || caught.status !== 401 || !cartToken || token) throw caught;
    clearCartToken();
    const cart = await api.cart(null, null, locale);
    if (cart.guestToken) saveCartToken(cart.guestToken);
    return cart;
  }
}

export function CartView({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setCart(await fetchCart(locale));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('cart.couldNotLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function updateItem(id: string, quantity: number) {
    setBusyItem(id);
    setError(null);
    try {
      const updated = await api.updateCartItem(id, { quantity }, readToken(), readCartToken(), locale);
      setCart({ ...updated, guestToken: cart?.guestToken });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('cart.couldNotLoad'));
    } finally {
      setBusyItem(null);
    }
  }

  async function removeItem(id: string) {
    setBusyItem(id);
    setError(null);
    try {
      const updated = await api.removeCartItem(id, readToken(), readCartToken(), locale);
      setCart({ ...updated, guestToken: cart?.guestToken });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('cart.couldNotLoad'));
    } finally {
      setBusyItem(null);
    }
  }

  const total = cart?.items.reduce((sum, item) => sum + item.lineTotalCents, 0) ?? 0;
  const currency = cart?.items[0]?.currency ?? cart?.currency ?? 'USD';

  if (loading) return <div className="skeleton" style={{ height: 260 }} />;

  if (error && !cart) {
    return (
      <div className="card card-pad stack center">
        <p className="form-error" role="alert">{error}</p>
        <button className="btn btn-primary" onClick={() => void load()}>{t('common.tryAgain')}</button>
      </div>
    );
  }

  if (!cart?.items.length) {
    return (
      <div className="empty-state">
        <h2>{t('cart.empty')}</h2>
        <p className="muted">{t('cart.emptyHint')}</p>
        <Link href="/search" className="btn btn-primary">{t('cart.browse')}</Link>
      </div>
    );
  }

  return (
    <div className="with-rail">
      <div className="with-rail-main stack">
        {error && <p className="form-error" role="alert">{error}</p>}
        {cart.items.map((item) => (
          <article key={item.id} className="card card-pad row wrap" style={{ gap: 'var(--sp-4)' }}>
            {item.imageUrl && (
              <img
                src={item.imageUrl}
                alt=""
                style={{ width: 112, height: 96, borderRadius: 8, objectFit: 'cover' }}
              />
            )}
            <div className="grow stack-sm" style={{ minWidth: 180 }}>
              <Link href={`/products/${item.slug}`} className="bold">{item.title}</Link>
              <span className="small muted">{item.optionName}</span>
              <span className="small muted">
                {formatDate(item.serviceDate, locale)}{item.timeSlot ? ` · ${item.timeSlot}` : ''}
              </span>
              <div className="row wrap" style={{ gap: 'var(--sp-3)' }}>
                <div className="qty-control">
                  <button
                    type="button"
                    aria-label={t('product.decreaseQty')}
                    disabled={busyItem === item.id || item.quantity <= item.minPerOrder}
                    onClick={() => void updateItem(item.id, item.quantity - 1)}
                  >−</button>
                  <span>{item.quantity}</span>
                  <button
                    type="button"
                    aria-label={t('product.increaseQty')}
                    disabled={busyItem === item.id || item.quantity >= item.maxPerOrder}
                    onClick={() => void updateItem(item.id, item.quantity + 1)}
                  >+</button>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busyItem === item.id}
                  onClick={() => void removeItem(item.id)}
                >
                  {t('cart.remove')}
                </button>
              </div>
            </div>
            <strong className="nowrap">{formatMoney(item.lineTotalCents, item.currency, locale)}</strong>
          </article>
        ))}
      </div>

      <aside className="booking-panel-col">
        <div className="card card-pad stack" style={{ position: 'sticky', top: 'calc(var(--header-h) + var(--sp-4))' }}>
          <h2 style={{ fontSize: 18 }}>{t('cart.lineCount', cart.items.length)}</h2>
          <div className="price-row total">
            <span>{t('cart.subtotal')}</span>
            <strong>{formatMoney(total, currency, locale)}</strong>
          </div>
          <p className="tiny muted">{t('cart.priceNotice')}</p>
          <Link href="/checkout?cart=1" className="btn btn-primary btn-lg btn-block">
            {t('cart.checkout')}
          </Link>
        </div>
      </aside>
    </div>
  );
}

export function CartCheckoutFlow({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const [cart, setCart] = useState<Cart | null>(null);
  const [order, setOrder] = useState<CheckoutResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cvc, setCvc] = useState('');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('2030');

  useEffect(() => {
    fetchCart(locale)
      .then(setCart)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : t('cart.couldNotLoad')))
      .finally(() => setLoading(false));
  }, []);

  async function reserveCart(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.checkoutCart(
        {
          contactEmail: email.trim(),
          contactPhone: phone || undefined,
          couponCode: couponCode || undefined,
          travelers: [{ fullName: name.trim() || email.split('@')[0], email: email.trim() }],
        },
        readToken(),
        readCartToken(),
        locale,
      );
      setOrder(created);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('checkout.couldNotStartBooking'));
    } finally {
      setBusy(false);
    }
  }

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    if (!order) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.payOrder(
        order.orderId,
        {
          method: 'CARD',
          idempotencyKey: `cart_checkout_${order.orderId}_${Date.now()}`,
          card: {
            number: cardNumber.replace(/\s/g, ''),
            expMonth: Number(expMonth),
            expYear: Number(expYear),
            cvc,
            holderName: name,
          },
        },
        readToken(),
      );
      if (result.status === 'CAPTURED') {
        setConfirmed(true);
        clearCartToken();
      } else {
        setError(result.failureMessage ?? t('checkout.declined'));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('checkout.failed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="container" style={{ paddingTop: 'var(--sp-7)' }}><div className="skeleton" style={{ height: 320 }} /></div>;
  if (!cart?.items.length) {
    return (
      <div className="container" style={{ paddingTop: 'var(--sp-7)' }}>
        <div className="card card-pad center stack">
          <p>{error ?? t('cart.empty')}</p>
          <Link className="btn btn-primary" href="/cart">{t('nav.cart')}</Link>
        </div>
      </div>
    );
  }

  if (confirmed && order) {
    return (
      <div className="container" style={{ padding: 'var(--sp-7) 0' }}>
        <div className="card card-pad center stack">
          <h1>{t('cart.confirmation')}</h1>
          <p>{t('cart.confirmationHint', order.orderNumber)}</p>
          <p className="mono bold">{order.orderNumber}</p>
          {readToken() ? (
            <Link className="btn btn-primary" href="/orders">{t('account.myBookings')}</Link>
          ) : (
            <p className="small muted">{t('cart.guestOrderHint')}</p>
          )}
          <Link href="/search" className="btn btn-secondary">{t('cart.browse')}</Link>
        </div>
      </div>
    );
  }

  const totalCents = order?.totalCents ?? cart.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const currency = order?.currency ?? cart.items[0]?.currency ?? cart.currency;

  return (
    <div className="container" style={{ padding: 'var(--sp-5) 0 var(--sp-7)' }}>
      <Link href="/cart" className="small" style={{ color: 'var(--brand-600)' }}>← {t('nav.cart')}</Link>
      <h1>{t('checkout.secureTitle')}</h1>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="with-rail">
        <div className="with-rail-main">
          {!order ? (
            <form className="card card-pad stack" onSubmit={reserveCart}>
              <h2 style={{ fontSize: 18 }}>{t('checkout.contactEmail')}</h2>
              <label className="field">
                <span className="label">{t('checkout.emailAddress')}</span>
                <input className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('checkout.leadGuestName')}</span>
                <input className="input" required value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('checkout.phoneOptional')}</span>
                <input className="input" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">{t('product.promoCode')}</span>
                <input className="input" value={couponCode} onChange={(event) => setCouponCode(event.target.value)} />
              </label>
              <button className="btn btn-primary btn-lg" disabled={busy}>
                {busy ? t('checkout.reservingSeats') : t('checkout.reserveAndContinue')}
              </button>
            </form>
          ) : (
            <form className="card card-pad stack" onSubmit={pay}>
              <h2 style={{ fontSize: 18 }}>{t('checkout.stepPayment')}</h2>
              <p className="small muted">{t('cart.orderCreatedHint', order.orderNumber)}</p>
              <label className="field">
                <span className="label">{t('checkout.cardNumber')}</span>
                <input className="input mono" required inputMode="numeric" autoComplete="cc-number" value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} placeholder="4242 4242 4242 4242" />
              </label>
              <div className="row" style={{ gap: 'var(--sp-3)' }}>
                <label className="field grow">
                  <span className="label">{t('checkout.expiryMonth')}</span>
                  <input className="input" required inputMode="numeric" value={expMonth} onChange={(event) => setExpMonth(event.target.value)} />
                </label>
                <label className="field grow">
                  <span className="label">{t('checkout.expiryYear')}</span>
                  <input className="input" required inputMode="numeric" value={expYear} onChange={(event) => setExpYear(event.target.value)} />
                </label>
                <label className="field grow">
                  <span className="label">{t('checkout.cvc')}</span>
                  <input className="input" required inputMode="numeric" autoComplete="cc-csc" value={cvc} onChange={(event) => setCvc(event.target.value)} />
                </label>
              </div>
              <button className="btn btn-accent btn-lg" disabled={busy}>
                {busy ? t('checkout.processing') : t('checkout.payAmount', formatMoney(totalCents, currency, locale))}
              </button>
            </form>
          )}
        </div>
        <aside className="booking-panel-col">
          <div className="card card-pad stack">
            <h2 style={{ fontSize: 18 }}>{t('checkout.orderSummary')}</h2>
            {cart.items.map((item) => (
              <div key={item.id} className="price-row">
                <span className="small">{item.title} × {item.quantity}</span>
                <span className="bold nowrap">{formatMoney(item.lineTotalCents, item.currency, locale)}</span>
              </div>
            ))}
            <div className="price-row total">
              <span>{t('checkout.totalInclTax')}</span>
              <strong>{formatMoney(totalCents, currency, locale)}</strong>
            </div>
            {!order && <p className="tiny muted">{t('cart.priceNotice')}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
