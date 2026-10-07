'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { readToken } from '@/lib/session';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * Standalone email-verification form.
 *
 * Used by `/verify-email`, which is where the header banner sends a signed-in
 * shopper whose address is still unconfirmed. The register flow has its own
 * inline copy of this step (it has just created the account and holds the
 * token), but a shopper who skipped it — or whose session predates the gate —
 * needs a page to come back to.
 *
 * The email is prefilled from the session rather than asked for: the API
 * accepts an email plus code, and a shopper who has to retype the address they
 * are already signed in as is being asked for something the app already knows.
 */
export function VerifyEmailForm({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    const token = readToken();
    if (!token) return;
    api
      .me(token)
      .then((profile) => setEmail(profile.email))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await api.verifyEmail({ email: email.trim(), code: code.trim() });
      setNotice(t('auth.verifySuccess'));
      // The header reads `emailVerified` from `/auth/me` on mount, so a refresh
      // is what clears the banner without a full reload dance.
      router.refresh();
    } catch {
      setError(t('auth.verifyFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setNotice(null);
    try {
      const result = await api.resendVerification({ email: email.trim() });
      if (result.devCode) setDevCode(result.devCode);
      setCooldown(45);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'RATE_LIMITED') {
        setCooldown(45);
      } else {
        setError(t('auth.verifyFailed'));
      }
    }
  }

  return (
    <form className="card card-pad stack" onSubmit={submit} data-testid="verify-page-form">
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('auth.verifyTitle')}</h1>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {t('auth.verifySubtitle', email || '…')}
        </p>
      </div>

      {devCode && (
        <p className="small badge badge-brand" data-testid="dev-code">
          {t('auth.devCodeHint', devCode)}
        </p>
      )}

      <label className="field">
        <span className="label">{t('auth.email')}</span>
        <input
          type="email"
          className="input"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label className="field">
        <span className="label">{t('auth.verifyCode')}</span>
        <input
          className="input mono"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder={t('auth.verifyCodePlaceholder')}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          data-testid="verify-page-code"
          style={{ letterSpacing: '0.4em', fontSize: 20 }}
        />
      </label>

      {error && <p className="form-error">{error}</p>}
      {notice && <p className="small badge badge-positive">{notice}</p>}

      <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6} data-testid="verify-page-submit">
        {busy ? t('auth.verifying') : t('auth.verifyAction')}
      </button>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={cooldown > 0} onClick={resend}>
          {cooldown > 0 ? t('auth.resendIn', cooldown) : t('auth.resendCode')}
        </button>
        <Link className="small" href="/orders">
          {t('auth.skipForNow')}
        </Link>
      </div>
    </form>
  );
}
