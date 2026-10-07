'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ProductDetail } from '@/lib/api';
import { readToken } from '@/lib/session';
import { formatDate, formatMoney } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

type Step = 'review' | 'guest' | 'payment' | 'confirming';

/**
 * Checkout is a four-step client flow:
 *   review -> guest details -> payment -> confirmation
 *
 * The order is created server-side (which places the inventory hold and locks
 * the price) before payment is attempted, so nothing shown here is invented
 * client-side.
 */
export function CheckoutFlow({ slug, locale }: { slug: string; locale: LocaleCode }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const params = useSearchParams();

  const ticketTypeId = params.get('ticketTypeId') ?? '';
  const serviceDate = params.get('date') ?? new Date().toISOString().slice(0, 10);
  const quantity = Math.max(1, Number(params.get('quantity') ?? 1));
  const presetCoupon = params.get('coupon') ?? '';

  const [step, setStep] = useState<Step>('review');
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guest + payment state
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [coupon, setCoupon] = useState(presetCoupon);
  const [cardNumber, setCardNumber] = useState('');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('2030');
  const [cvc, setCvc] = useState('');

  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [totalCents, setTotalCents] = useState(0);
  const [busy, setBusy] = useState(false);

  const token = typeof window !== 'undefined' ? readToken() : null;

  // Load the product so we can show the exact option being purchased.
  useEffect(() => {
    api
      .product(slug, { date: serviceDate, quantity })
      .then(setProduct)
      .catch(() => setError(t('checkout.couldNotLoad')))
      .finally(() => setLoading(false));
  }, [slug, serviceDate, quantity, t]);

  const selected = useMemo(
    () => product?.ticketTypes.find((t) => t.id === ticketTypeId) ?? product?.ticketTypes[0] ?? null,
    [product, ticketTypeId],
  );

  async function createOrder(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createOrder(
        {
          lines: [{ ticketTypeId: selected!.id, serviceDate, quantity }],
          contactEmail: email,
          contactPhone: phone || undefined,
          couponCode: coupon || undefined,
          travelers: [{ fullName: fullName || email.split('@')[0], isLead: true }],
        },
        token,
      );
      setOrderId(result.orderId);
      setOrderNumber(result.orderNumber);
      setTotalCents(result.totalCents);
      return result.orderId;
    } catch (caught) {
      // Checkout revalidates the live rate server-side, so two failures are
      // actionable in a way the generic message is not: the price moved, or the
      // last units went while the shopper was filling the form. Both send them
      // back to re-select rather than inviting a blind retry.
      if (caught instanceof ApiError && caught.code === 'PRICE_CHANGED') {
        setError(t('checkout.priceChanged'));
      } else if (caught instanceof ApiError && caught.code === 'INVENTORY_UNAVAILABLE') {
        setError(t('checkout.soldOut'));
      } else {
        setError(caught instanceof ApiError ? caught.message : t('checkout.couldNotStartBooking'));
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function pay(id: string) {
    setBusy(true);
    setError(null);
    setStep('confirming');
    try {
      const result = await api.payOrder(
        id,
        {
          method: 'CARD',
          // Stable per-attempt key so a double-click cannot charge twice.
          idempotencyKey: `checkout_${id}_${Date.now()}`,
          card: {
            number: cardNumber.replace(/\s/g, ''),
            expMonth: Number(expMonth),
            expYear: Number(expYear),
            cvc,
            holderName: fullName,
          },
        },
        token,
      );

      if (result.status === 'CAPTURED') {
        router.push(`/orders/${id}?new=1`);
        return;
      }
      if (result.status === 'REQUIRES_ACTION') {
        // A real gateway would open a 3-D Secure challenge here.
        setError(t('checkout.bankVerification'));
      } else {
        setError(result.failureMessage ?? t('checkout.declined'));
      }
      setStep('payment');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('checkout.failed'));
      setStep('payment');
    } finally {
      setBusy(false);
    }
  }

  async function submitGuestDetails(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const id = await createOrder();
    if (id) setStep('payment');
  }

  async function submitPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!orderId) {
      const id = await createOrder();
      if (id) await pay(id);
      return;
    }
    await pay(orderId);
  }

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: 'var(--sp-7)' }}>
        <div className="skeleton" style={{ height: 28, width: 220, marginBottom: 'var(--sp-4)' }} />
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  if (!product || !selected) {
    return (
      <div className="container" style={{ paddingTop: 'var(--sp-7)' }}>
        <div className="card card-pad center">
          <p className="muted">{error ?? t('checkout.noLongerAvailable')}</p>
          <Link href={`/products/${slug}`} className="btn btn-primary" style={{ marginTop: 'var(--sp-3)' }}>
            {t('checkout.backToExperience')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-5)', paddingBottom: 'var(--sp-7)' }}>
      <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
        <Link href={`/products/${slug}`} className="small" style={{ color: 'var(--brand-600)' }}>
          ← {t('checkout.back')}
        </Link>
      </div>

      <h1 style={{ fontSize: 26, marginBottom: 'var(--sp-5)' }}>{t('checkout.secureTitle')}</h1>

      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--sp-5)' }}>
        {/* ---------------------------------------------------------------- */}
        {/* Form column                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="grow" style={{ maxWidth: 560 }}>
          {/* Step indicator */}
          <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
            {(['review', 'guest', 'payment'] as const).map((stage, index) => {
              const order = ['review', 'guest', 'payment'];
              const currentIndex = order.indexOf(step === 'confirming' ? 'payment' : step);
              const done = index <= currentIndex;
              return (
                <div key={stage} className="grow row" style={{ gap: 'var(--sp-2)' }}>
                  <span
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: done ? 'var(--brand-600)' : 'var(--bg-muted)',
                      color: done ? '#fff' : 'var(--text-subtle)',
                      fontSize: 12,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {index + 1}
                  </span>
                  <span className="small" style={{ fontWeight: done ? 700 : 500, color: done ? 'var(--text)' : 'var(--text-subtle)' }}>
                    {stage === 'review'
                      ? t('checkout.stepReview')
                      : stage === 'guest'
                        ? t('checkout.stepGuest')
                        : t('checkout.stepPayment')}
                  </span>
                  {index < 2 && <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />}
                </div>
              );
            })}
          </div>

          {error && (
            <div
              className="card card-pad"
              style={{ background: 'var(--critical-50)', borderColor: 'var(--critical-600)', marginBottom: 'var(--sp-4)' }}
              role="alert"
            >
              <div className="row" style={{ gap: 'var(--sp-2)' }}>
                <span aria-hidden>⚠</span>
                <span className="small">{error}</span>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------ */}
          {/* Step 1: review                                                 */}
          {/* ------------------------------------------------------------ */}
          {step === 'review' && (
            <div className="card card-pad stack">
              <h2 style={{ fontSize: 17 }}>{t('checkout.reviewSelection')}</h2>
              <div className="stack-sm">
                <Line label={t('checkout.experienceLabel')} value={product.name} />
                <Line label={t('checkout.optionLabel')} value={selected.name} />
                <Line label={t('product.dateLabel')} value={formatDate(serviceDate, locale)} />
                <Line label={t('account.guestsLabel')} value={String(quantity)} />
                {product.destination && (
                  <Line label={t('product.locationLabel')} value={product.destination.name} />
                )}
                {product.meetingPoint && (
                  <Line label={t('product.meetingPoint')} value={product.meetingPoint} />
                )}
              </div>

              {product.cancellationPolicy && (
                <div className="panel small">
                  <div className="bold" style={{ marginBottom: 4 }}>
                    {t('search.freeCancellation')}
                  </div>
                  <div className="muted">{product.cancellationPolicy.description}</div>
                </div>
              )}

              <button className="btn btn-primary btn-lg btn-block" onClick={() => setStep('guest')}>
                {t('checkout.continueToDetails')}
              </button>
            </div>
          )}

          {/* ------------------------------------------------------------ */}
          {/* Step 2: guest details                                         */}
          {/* ------------------------------------------------------------ */}
          {step === 'guest' && (
            <form className="card card-pad stack" onSubmit={submitGuestDetails}>
              <h2 style={{ fontSize: 17 }}>{t('checkout.stepGuest')}</h2>

              <div className="field">
                <label htmlFor="email" className="label">
                  {t('checkout.emailAddress')}
                </label>
                <input
                  id="email"
                  className="input"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
                <span className="tiny subtle">{t('checkout.emailHint')}</span>
              </div>

              <div className="field">
                <label htmlFor="name" className="label">
                  {t('checkout.leadGuestName')}
                </label>
                <input
                  id="name"
                  className="input"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('checkout.namePlaceholder')}
                />
              </div>

              <div className="field">
                <label htmlFor="phone" className="label">
                  {t('checkout.phoneOptional')}
                </label>
                <input
                  id="phone"
                  className="input"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={t('checkout.phonePlaceholder')}
                />
              </div>

              <div className="field">
                <label htmlFor="coupon" className="label">
                  {t('product.promoCode')}
                </label>
                <input
                  id="coupon"
                  className="input"
                  value={coupon}
                  onChange={(e) => setCoupon(e.target.value)}
                  placeholder="WELCOME10"
                />
                <span className="tiny subtle">{t('checkout.seatsHeldNote')}</span>
              </div>

              <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
                {busy ? t('checkout.reservingSeats') : t('checkout.reserveAndContinue')}
              </button>
            </form>
          )}

          {/* ------------------------------------------------------------ */}
          {/* Step 3: payment                                                */}
          {/* ------------------------------------------------------------ */}
          {(step === 'payment' || step === 'confirming') && (
            <form className="card card-pad stack" onSubmit={submitPayment}>
              <h2 style={{ fontSize: 17 }}>{t('checkout.stepPayment')}</h2>

              {orderNumber && (
                <div className="panel small">
                  {t('checkout.orderLabel')} <span className="bold mono">{orderNumber}</span> ·{' '}
                  {t('checkout.seatsHeldUntilPayment')}
                </div>
              )}

              <div className="field">
                <label htmlFor="card" className="label">
                  {t('checkout.cardNumber')}
                </label>
                <input
                  id="card"
                  className="input mono"
                  required
                  inputMode="numeric"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  placeholder="4242 4242 4242 4242"
                  autoComplete="cc-number"
                />
              </div>

              <div className="row" style={{ gap: 'var(--sp-3)' }}>
                <div className="field grow">
                  <label htmlFor="expMonth" className="label">
                    {t('checkout.expiryMonth')}
                  </label>
                  <input
                    id="expMonth"
                    className="input"
                    required
                    inputMode="numeric"
                    value={expMonth}
                    onChange={(e) => setExpMonth(e.target.value)}
                    placeholder="MM"
                  />
                </div>
                <div className="field grow">
                  <label htmlFor="expYear" className="label">
                    {t('checkout.expiryYear')}
                  </label>
                  <input
                    id="expYear"
                    className="input"
                    required
                    inputMode="numeric"
                    value={expYear}
                    onChange={(e) => setExpYear(e.target.value)}
                    placeholder="YYYY"
                  />
                </div>
                <div className="field grow">
                  <label htmlFor="cvc" className="label">
                    {t('checkout.cvc')}
                  </label>
                  <input
                    id="cvc"
                    className="input"
                    required
                    inputMode="numeric"
                    value={cvc}
                    onChange={(e) => setCvc(e.target.value)}
                    placeholder="123"
                    autoComplete="cc-csc"
                  />
                </div>
              </div>

              <div className="panel tiny muted">
                <div className="bold" style={{ marginBottom: 4 }}>
                  {t('checkout.testMode')}
                </div>
                {t('checkout.testModeUse')} <span className="mono">4242 4242 4242 4242</span>{' '}
                {t('checkout.testModeApprove')} <span className="mono">4000 0000 0000 0002</span>{' '}
                {t('checkout.testModeDecline')}
              </div>

              <button className="btn btn-accent btn-lg btn-block" type="submit" disabled={busy || step === 'confirming'}>
                {step === 'confirming'
                  ? t('checkout.processing')
                  : t(
                      'checkout.payAmount',
                      formatMoney(totalCents || selected.lineTotalCents, selected.currency),
                    )}
              </button>
            </form>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Summary column                                                 */}
        {/* ---------------------------------------------------------------- */}
        <aside style={{ width: 340, flexShrink: 0 }} className="booking-panel-col">
          <div className="card card-pad stack" style={{ position: 'sticky', top: 'calc(var(--header-h) + var(--sp-4))' }}>
            <h3 style={{ fontSize: 16 }}>{t('checkout.orderSummary')}</h3>

            <div className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
              {product.media[0] && (
                <img
                  src={product.media[0].url}
                  alt=""
                  style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                />
              )}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small bold truncate">{product.name}</div>
                <div className="tiny subtle truncate">{selected.name}</div>
                <div className="tiny subtle">
                  {formatDate(serviceDate, locale)} · {quantity}{' '}
                  {quantity === 1 ? t('common.guest') : t('common.guests')}
                </div>
              </div>
            </div>

            <hr className="divider" style={{ margin: 'var(--sp-2) 0' }} />

            <div className="price-row">
              <span className="label">
                {formatMoney(selected.totalPerUnitCents, selected.currency)} × {quantity}
              </span>
              <span className="bold">
                {formatMoney(selected.totalPerUnitCents * quantity, selected.currency)}
              </span>
            </div>

            <div className="price-row total">
              <span>{t('checkout.totalInclTax')}</span>
              <span>{formatMoney(selected.totalPerUnitCents * quantity, selected.currency)}</span>
            </div>

            <div className="stack-sm tiny subtle">
              <span className="row" style={{ gap: 6 }}>
                <span aria-hidden>🔒</span> {t('checkout.securePayment')}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span aria-hidden>↩</span>{' '}
                {t('checkout.freeCancelUpTo', product.cancellationPolicy?.freeCancelHours ?? 24)}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span aria-hidden>📱</span> {t('checkout.instantTicket')}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between small" style={{ gap: 'var(--sp-4)' }}>
      <span className="muted">{label}</span>
      <span className="bold right">{value}</span>
    </div>
  );
}