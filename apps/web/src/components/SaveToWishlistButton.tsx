'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { readToken } from '@/lib/session';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export function SaveToWishlistButton({
  productId,
  serviceDate,
  locale,
}: {
  productId: string;
  serviceDate?: string;
  locale: LocaleCode;
}) {
  const t = createTranslator(locale);
  const [token, setToken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const currentToken = readToken();
    setToken(currentToken);
    setSessionReady(true);
    if (!currentToken) return;

    api
      .wishlist(currentToken)
      .then((items) => setSaved(items.some((item) => item.productId === productId)))
      .catch((caught) => {
        const messages = createTranslator(locale);
        setError(caught instanceof ApiError && caught.status === 401
          ? messages('common_errors.sessionExpired')
          : messages('travel.saveFailed'));
      });
  }, [locale, productId]);

  if (!sessionReady) return null;
  if (!token) {
    return (
      <Link href="/login" className="btn btn-ghost btn-sm">
        {t('travel.signInToSave')}
      </Link>
    );
  }

  async function toggleSaved() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (saved) {
        await api.removeWishlistItem(productId, token);
        setSaved(false);
      } else {
        await api.addWishlistItem({ productId, ...(serviceDate ? { serviceDate } : {}) }, token);
        setSaved(true);
      }
    } catch {
      setError(createTranslator(locale)('travel.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm" style={{ alignItems: 'flex-start' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={toggleSaved}
        disabled={busy}
        aria-pressed={saved}
      >
        <span aria-hidden>{saved ? '♥' : '♡'}</span>
        {saved ? t('travel.savedJourney') : t('travel.saveJourney')}
      </button>
      {error && <span className="tiny" role="alert">{error}</span>}
    </div>
  );
}
