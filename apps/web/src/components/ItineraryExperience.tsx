'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, type Itinerary, type OrderSummary } from '@/lib/api';
import { readToken } from '@/lib/session';
import { formatDate, formatMoney } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { htmlLang } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export function ItineraryExperience({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const [token, setToken] = useState<string | null>(null);
  const [plans, setPlans] = useState<Itinerary[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedOrders, setSelectedOrders] = useState<Record<string, string>>({});
  const [days, setDays] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (currentToken: string) => {
    const [itineraries, confirmedOrders, completedOrders] = await Promise.all([
      api.itineraries(currentToken),
      api.orders({ status: 'CONFIRMED', pageSize: 50 }, currentToken),
      api.orders({ status: 'COMPLETED', pageSize: 50 }, currentToken),
    ]);
    setPlans(itineraries);
    setOrders([...confirmedOrders.items, ...completedOrders.items]);
  }, []);

  useEffect(() => {
    const currentToken = readToken();
    setToken(currentToken);
    if (!currentToken) {
      setLoading(false);
      return;
    }

    load(currentToken)
      .catch((caught) => {
        const messages = createTranslator(locale);
        setError(caught instanceof ApiError && caught.status === 401
          ? messages('common_errors.sessionExpired')
          : messages('travel.requestFailed'));
      })
      .finally(() => setLoading(false));
  }, [load, locale]);

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !name.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.createItinerary({
        name: name.trim(),
        ...(destination.trim() ? { destinationSummary: destination.trim() } : {}),
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      }, token);
      await load(token);
      setName('');
      setDestination('');
      setStartDate('');
      setEndDate('');
      setMessage(t('travel.planCreated'));
    } catch {
      setError(t('travel.planCreateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function addBooking(itineraryId: string) {
    const orderId = selectedOrders[itineraryId];
    if (!token || !orderId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const day = Number(days[itineraryId] || 1);
      await api.addOrderToItinerary(itineraryId, { orderId, day }, token);
      await load(token);
      setSelectedOrders((current) => ({ ...current, [itineraryId]: '' }));
      setMessage(t('travel.bookingAdded'));
    } catch {
      setError(t('travel.bookingAddFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 220 }} />;
  if (!token) {
    return (
      <div className="card card-pad center stack">
        <p className="muted">{t('travel.signInTitle')}</p>
        <Link href="/login" className="btn btn-primary">{t('common.signIn')}</Link>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="small" style={{ color: 'var(--success-700)' }} role="status">{message}</p>}

      <form className="card card-pad stack" onSubmit={createPlan}>
        <h2 style={{ fontSize: 18 }}>{t('travel.createPlan')}</h2>
        <div className="grid grid-2">
          <label className="field">
            <span>{t('travel.planName')}</span>
            <input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>{t('travel.destination')}</span>
            <input maxLength={300} value={destination} onChange={(event) => setDestination(event.target.value)} />
          </label>
          <label className="field">
            <span>{t('travel.startDate')}</span>
            <input type="date" lang={htmlLang(locale)} value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label className="field">
            <span>{t('travel.endDate')}</span>
            <input type="date" lang={htmlLang(locale)} value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} />
          </label>
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? t('travel.creatingPlan') : t('travel.createPlan')}
          </button>
        </div>
      </form>

      {plans.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: 40 }} aria-hidden>🧭</div>
          <h2>{t('travel.plansEmpty')}</h2>
          <p className="muted">{t('travel.plansEmptyHint')}</p>
        </div>
      ) : (
        <div className="stack">
          {plans.map((plan) => (
            <section key={plan.id} className="card card-pad stack">
              <div className="row-between wrap">
                <div>
                  <h2 style={{ fontSize: 20 }}>{plan.name}</h2>
                  {plan.destinationSummary && <p className="muted small">{plan.destinationSummary}</p>}
                  {(plan.startDate || plan.endDate) && (
                    <p className="tiny subtle">
                      {plan.startDate ? formatDate(plan.startDate, locale) : ''}
                      {plan.startDate && plan.endDate ? ' – ' : ''}
                      {plan.endDate ? formatDate(plan.endDate, locale) : ''}
                    </p>
                  )}
                </div>
                <div className="right">
                  <div className="tiny subtle">{t('travel.planItemCount', plan.itemCount)}</div>
                </div>
              </div>

              {plan.items.length > 0 && (
                <ol className="stack-sm" style={{ paddingLeft: 22 }}>
                  {plan.items.map((item) => {
                    const currency = orders.find((order) => order.id === item.orderId)?.currency;
                    return (
                      <li key={item.id}>
                        <div className="row-between wrap">
                          <span><strong>{t('travel.day')} {item.day}:</strong> {item.title}</span>
                          {item.costCents > 0 && currency && (
                            <span className="tiny subtle">{formatMoney(item.costCents, currency)}</span>
                          )}
                        </div>
                        {item.notes && <div className="tiny subtle">{item.notes}</div>}
                      </li>
                    );
                  })}
                </ol>
              )}

              {orders.length > 0 ? (
                <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
                  <label className="field grow">
                    <span>{t('travel.addBooking')}</span>
                    <select
                      value={selectedOrders[plan.id] ?? ''}
                      onChange={(event) => setSelectedOrders((current) => ({ ...current, [plan.id]: event.target.value }))}
                    >
                      <option value="">{t('travel.chooseBooking')}</option>
                      {orders.map((order) => (
                        <option key={order.id} value={order.id}>
                          {order.orderNumber} · {order.items.map((item) => item.productName).join(', ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ width: 120 }}>
                    <span>{t('travel.day')}</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={days[plan.id] ?? '1'}
                      onChange={(event) => setDays((current) => ({ ...current, [plan.id]: event.target.value }))}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !selectedOrders[plan.id]}
                    onClick={() => void addBooking(plan.id)}
                  >
                    {t('travel.addToPlan')}
                  </button>
                </div>
              ) : (
                <p className="tiny subtle">{t('travel.noConfirmedBookings')}</p>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
