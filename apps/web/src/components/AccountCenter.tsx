'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type AddPaymentMethodInput, type SavedPaymentMethod } from '@/lib/api';
import { readToken } from '@/lib/session';
import { formatMoney, formatDate } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

type Overview = Awaited<ReturnType<typeof api.accountOverview>>;

const CHANNEL_LABEL: Record<string, string> = {
  CARD: 'Card (Visa / Mastercard / Amex)',
  PAYPAL: 'PayPal',
  CRYPTO_TRC20: 'USDT (TRC20)',
};

/**
 * The account centre: profile, stored-value balance, saved payment methods and
 * travel documents in one place.
 *
 * A saved method is a *reference* — brand and last four, or a wallet identity.
 * Nothing here is a secret, and none of it settles money on its own: the
 * settlement rails run sandbox-only in this stage (see
 * `apps/api/src/modules/supply/credentials.ts`), which is why the panel is
 * labelled rather than presented as a live checkout.
 */
export function AccountCenter({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [methodCount, setMethodCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<AddPaymentMethodInput>({ channel: 'CARD', card: { brand: 'visa', last4: '' } });
  const [draftLabel, setDraftLabel] = useState('');

  const load = useCallback(async () => {
    const token = readToken();
    if (!token) {
      setError(t('account.signInToAccount'));
      setLoading(false);
      return;
    }
    try {
      const data = await api.accountOverview(token);
      setOverview(data);
      setMethodCount(data.paymentMethods.length);
    } catch {
      setError(t('account.couldNotLoadTickets'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshMethods() {
    const token = readToken();
    if (!token) return;
    const data = await api.paymentMethods(token);
    setOverview((prev) => (prev ? { ...prev, paymentMethods: data.methods } : prev));
    setMethodCount(data.methods.length);
  }

  async function submit() {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      // Only the fields the chosen channel needs are sent. A card sends a brand
      // and the last four; there is no field for a full number, by design.
      const body: AddPaymentMethodInput = { channel: draft.channel, label: draftLabel || undefined };
      if (draft.channel === 'CARD') body.card = draft.card;
      if (draft.channel === 'PAYPAL') body.paypal = draft.paypal;
      if (draft.channel === 'CRYPTO_TRC20') body.crypto = draft.crypto;
      await api.addPaymentMethod(token, body);
      setDraftLabel('');
      setDraft({ channel: draft.channel, card: { brand: 'visa', last4: '' } });
      await refreshMethods();
    } catch {
      setError(t('account.signInToAccount'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await api.removePaymentMethod(token, id);
      await refreshMethods();
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    const token = readToken();
    if (!token) return;
    setBusy(true);
    try {
      await api.setDefaultPaymentMethod(token, id);
      await refreshMethods();
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="skeleton" style={{ height: 260 }} />;
  }

  if (error || !overview) {
    return (
      <div className="empty-state">
        <p className="muted">{error ?? t('account.signInToAccount')}</p>
        <Link className="btn btn-primary" href="/login">{t('nav.signIn')}</Link>
      </div>
    );
  }

  const { profile, wallet, loyalty, travelers, paymentMethods, stats } = overview;

  return (
    <div className="grid" style={{ gap: 'var(--sp-5)' }}>
      {/* Profile + balances ------------------------------------------------- */}
      <div className="grid grid-2" style={{ gap: 'var(--sp-4)' }}>
        <section className="card card-pad">
          <h2 style={{ fontSize: 17, marginTop: 0 }}>{t('account.profile')}</h2>
          <p className="bold" style={{ margin: '4px 0' }}>{profile.firstName} {profile.lastName}</p>
          <p className="small muted" style={{ margin: '2px 0' }}>{profile.email}</p>
          {profile.phone ? <p className="small muted" style={{ margin: '2px 0' }}>{profile.phone}</p> : null}
          <div className="divider" style={{ margin: '10px 0' }} />
          <p className="tiny subtle">
            {t('account.memberSince')} {formatDate(profile.memberSince)}
            {' · '}
            {profile.emailVerified ? t('account.emailVerified') : t('account.notVerified')}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <span className="badge badge-neutral">{t('account.orders')} {stats.orders}</span>
            <span className="badge badge-neutral">{t('account.wishlist')} {stats.wishlist}</span>
            <span className="badge badge-neutral">{t('account.reviews')} {stats.reviews}</span>
          </div>
        </section>

        <section className="card card-pad">
          <h2 style={{ fontSize: 17, marginTop: 0 }}>{t('account.balance')}</h2>
          <p style={{ fontSize: 28, fontWeight: 700, margin: '6px 0' }}>{formatMoney(wallet.balanceCents, 'USD')}</p>
          <p className="tiny subtle">{t('account.walletHint')}</p>
          <div className="divider" style={{ margin: '10px 0' }} />
          <p className="small" style={{ margin: 0 }}>
            {t('account.pointsBalance')}: <span className="bold">{loyalty?.points ?? 0}</span>
            {loyalty ? <span className="badge badge-brand" style={{ marginLeft: 8 }}>{loyalty.tier}</span> : null}
          </p>
        </section>
      </div>

      {/* Payment methods ---------------------------------------------------- */}
      <section className="card card-pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>{t('account.savedCards')}</h2>
          <span className="badge badge-warning">{t('account.sandboxNote')}</span>
        </div>

        {paymentMethods.length === 0 ? (
          <p className="muted small">{t('account.noCards')}</p>
        ) : (
          <div className="grid" style={{ gap: 8, marginTop: 10 }}>
            {paymentMethods.map((method: SavedPaymentMethod) => (
              <div key={method.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
                <div className="grow">
                  <span className="bold">{CHANNEL_LABEL[method.channel] ?? method.channel}</span>
                  {method.last4 ? <span className="muted small"> · ••••{method.last4}</span> : null}
                  {method.label ? <span className="tiny subtle"> · {method.label}</span> : null}
                  {method.isDefault ? <span className="badge badge-positive" style={{ marginLeft: 8 }}>{t('account.defaultBadge')}</span> : null}
                </div>
                {!method.isDefault ? (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => makeDefault(method.id)}>
                    {t('account.setDefault')}
                  </button>
                ) : null}
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(method.id)}>
                  {t('account.remove')}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add form --------------------------------------------------------- */}
        <div className="divider" style={{ margin: '14px 0' }} />
        <h3 style={{ fontSize: 15, marginTop: 0 }}>{t('account.addCard')}</h3>
        <div className="grid grid-3" style={{ gap: 10 }}>
          <label className="field">
            <span className="label">{t('account.savedCards')}</span>
            <select
              className="input"
              value={draft.channel}
              onChange={(e) => {
                const channel = e.target.value as AddPaymentMethodInput['channel'];
                setDraft(
                  channel === 'CARD'
                    ? { channel, card: { brand: 'visa', last4: '' } }
                    : channel === 'PAYPAL'
                      ? { channel, paypal: { payerId: '', email: '' } }
                      : { channel, crypto: { address: '', network: 'tron' } },
                );
              }}
            >
              <option value="CARD">{CHANNEL_LABEL.CARD}</option>
              <option value="PAYPAL">{CHANNEL_LABEL.PAYPAL}</option>
              <option value="CRYPTO_TRC20">{CHANNEL_LABEL.CRYPTO_TRC20}</option>
            </select>
          </label>

          {draft.channel === 'CARD' ? (
            <>
              <label className="field">
                <span className="label">{t('account.cardBrand')}</span>
                <input
                  className="input"
                  value={draft.card?.brand ?? ''}
                  onChange={(e) => setDraft({ ...draft, card: { brand: e.target.value, last4: draft.card?.last4 ?? '' } })}
                />
              </label>
              <label className="field">
                <span className="label">{t('account.last4')}</span>
                <input
                  className="input"
                  inputMode="numeric"
                  maxLength={4}
                  value={draft.card?.last4 ?? ''}
                  onChange={(e) => setDraft({ ...draft, card: { brand: draft.card?.brand ?? 'visa', last4: e.target.value.replace(/\D/g, '') } })}
                />
              </label>
            </>
          ) : null}

          {draft.channel === 'PAYPAL' ? (
            <>
              <label className="field">
                <span className="label">{t('account.paypalEmail')}</span>
                <input
                  className="input"
                  type="email"
                  value={draft.paypal?.email ?? ''}
                  onChange={(e) => setDraft({ ...draft, paypal: { payerId: draft.paypal?.payerId ?? '', email: e.target.value } })}
                />
              </label>
              <label className="field">
                <span className="label">Payer ID</span>
                <input
                  className="input"
                  value={draft.paypal?.payerId ?? ''}
                  onChange={(e) => setDraft({ ...draft, paypal: { payerId: e.target.value, email: draft.paypal?.email } })}
                />
              </label>
            </>
          ) : null}

          {draft.channel === 'CRYPTO_TRC20' ? (
            <label className="field" style={{ gridColumn: 'span 2' }}>
              <span className="label">{t('account.trc20Address')}</span>
              <input
                className="input"
                placeholder="T..."
                value={draft.crypto?.address ?? ''}
                onChange={(e) => setDraft({ ...draft, crypto: { address: e.target.value, network: 'tron' } })}
              />
            </label>
          ) : null}

          <label className="field">
            <span className="label">{t('account.label')}</span>
            <input className="input" value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{t('account.save')}</button>
        </div>
        <p className="tiny subtle" style={{ marginTop: 8 }}>{t('account.sandboxNote')}</p>
      </section>

      {/* Travelers ---------------------------------------------------------- */}
      <section className="card card-pad">
        <h2 style={{ fontSize: 17, marginTop: 0 }}>{t('account.travelers')}</h2>
        {travelers.length === 0 ? (
          <p className="muted small">{t('account.noCards')}</p>
        ) : (
          <div className="grid grid-2" style={{ gap: 8 }}>
            {travelers.map((traveler) => (
              <div key={traveler.id} className="small">
                <span className="bold">{traveler.fullName}</span>
                {traveler.isDefault ? <span className="badge badge-neutral" style={{ marginLeft: 8 }}>{t('account.defaultBadge')}</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
