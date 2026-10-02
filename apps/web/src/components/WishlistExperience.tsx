'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api, type WishlistItem } from '@/lib/api';
import { readToken } from '@/lib/session';
import { formatDate } from '@/lib/format';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export function WishlistExperience({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const currentToken = readToken();
    setToken(currentToken);
    if (!currentToken) {
      setLoading(false);
      return;
    }

    api
      .wishlist(currentToken)
      .then(setItems)
      .catch((caught) => {
        const messages = createTranslator(locale);
        setError(caught instanceof ApiError && caught.status === 401
          ? messages('common_errors.sessionExpired')
          : messages('travel.requestFailed'));
      })
      .finally(() => setLoading(false));
  }, [locale]);

  async function remove(productId: string) {
    if (!token) return;
    try {
      await api.removeWishlistItem(productId, token);
      setItems((current) => current.filter((item) => item.productId !== productId));
    } catch {
      setError(t('travel.requestFailed'));
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 180 }} />;
  if (!token) {
    return (
      <div className="card card-pad center stack">
        <p className="muted">{t('travel.signInTitle')}</p>
        <Link href="/login" className="btn btn-primary">{t('common.signIn')}</Link>
      </div>
    );
  }

  return (
    <section className="stack">
      {error && <p className="form-error" role="alert">{error}</p>}
      {items.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: 40 }} aria-hidden>♡</div>
          <h2>{t('travel.wishlistEmpty')}</h2>
          <p className="muted">{t('travel.wishlistEmptyHint')}</p>
          <Link href="/search" className="btn btn-primary">{t('account.browse')}</Link>
        </div>
      ) : (
        <div className="grid grid-2">
          {items.map((item) => (
            <article key={item.productId} className="card card-pad row" style={{ gap: 'var(--sp-3)' }}>
              <Link href={`/products/${item.slug}`} className="row grow" style={{ minWidth: 0, gap: 'var(--sp-3)' }}>
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    style={{ width: 92, height: 92, objectFit: 'cover', borderRadius: 'var(--r-md)', flexShrink: 0 }}
                  />
                ) : (
                  <div className="card center" style={{ width: 92, height: 92, flexShrink: 0 }} aria-hidden>✦</div>
                )}
                <div className="grow" style={{ minWidth: 0 }}>
                  <h2 className="small bold">{item.title}</h2>
                  {item.serviceDate && (
                    <p className="tiny subtle">{t('travel.savedFor', formatDate(item.serviceDate, locale))}</p>
                  )}
                </div>
              </Link>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(item.productId)}>
                {t('travel.remove')}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
