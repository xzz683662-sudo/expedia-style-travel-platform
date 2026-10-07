'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { saveSession } from '@/lib/session';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/** Email is the identity; the label is resolved per locale. */
const DEMO_ACCOUNTS = [
  { email: 'traveler@easytrip.test', key: 'auth.demoTraveller' },
  { email: 'admin@easytrip.test', key: 'auth.demoAdmin' },
  { email: 'support@easytrip.test', key: 'auth.demoSupport' },
] as const;

function nextPath(raw: string | null): string {
  // Only allow same-origin relative paths so `?next=` can't become an open redirect.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/orders';
  return raw;
}

export function LoginForm({ locale }: { locale: LocaleCode }) {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
      <LoginFormInner locale={locale} />
    </Suspense>
  );
}

function LoginFormInner({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.login({ email: email.trim(), password });
      saveSession(result.token, result.user);
      router.push(nextPath(params.get('next')));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('auth.couldNotSignIn'));
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="card card-pad stack" onSubmit={submit}>
        <label className="field">
          <span className="label">{t('auth.email')}</span>
          <input
            type="email"
            className="input"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <label className="field">
          <span className="label">{t('auth.password')}</span>
          <input
            type="password"
            className="input"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('auth.signingIn') : t('common.signIn')}
        </button>

        <p className="small muted center" style={{ margin: 0 }}>
          {t('auth.noAccount')} <Link href="/register">{t('auth.createAccount')}</Link>
        </p>
      </form>

      <details className="card card-pad">
        <summary className="small bold" style={{ cursor: 'pointer' }}>
          {t('auth.demoAccounts')} ({t('auth.demoPassword')} <code className="mono">Password123!</code>)
        </summary>
        <div className="stack-sm" style={{ marginTop: 'var(--sp-3)' }}>
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="demo-account"
              onClick={() => {
                setEmail(account.email);
                setPassword('Password123!');
              }}
            >
              <span className="mono small bold">{account.email}</span>
              <span className="tiny subtle">{t(account.key)}</span>
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

export function RegisterForm({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- Verification step ---
  // Registration no longer signs the shopper straight in: the account exists but
  // the address is unconfirmed, and checkout is gated on it. The form therefore
  // has two steps, and the second one is the same code box the header banner
  // links to.
  const [step, setStep] = useState<'details' | 'verify'>('details');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function update(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.register({
        email: form.email.trim(),
        password: form.password,
        firstName: form.firstName.trim() || 'Traveller',
        lastName: form.lastName.trim() || '',
      });
      saveSession(result.token, result.user);
      setDevCode(result.emailVerification?.devCode ?? null);
      setCooldown(30);
      setStep('verify');
      setBusy(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('auth.couldNotRegister'));
      setBusy(false);
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await api.verifyEmail({ email: form.email.trim(), code: code.trim() });
      setNotice(t('auth.verifySuccess'));
      router.push('/orders');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? t('auth.verifyFailed') : t('auth.verifyFailed'));
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setNotice(null);
    try {
      const result = await api.resendVerification({ email: form.email.trim() });
      if (result.devCode) setDevCode(result.devCode);
      // 45s is the API's cooldown; mirroring it here avoids a guaranteed 429.
      setCooldown(45);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'RATE_LIMITED') {
        setCooldown(45);
      } else {
        setError(t('auth.verifyFailed'));
      }
    }
  }

  if (step === 'verify') {
    return (
      <form className="card card-pad stack" onSubmit={verify} data-testid="verify-form">
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('auth.verifyTitle')}</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {t('auth.verifySubtitle', form.email.trim())}
          </p>
        </div>

        {devCode && <p className="small badge badge-brand" data-testid="dev-code">{t('auth.devCodeHint', devCode)}</p>}

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
            data-testid="verify-code"
            style={{ letterSpacing: '0.4em', fontSize: 20 }}
          />
        </label>

        {error && <p className="form-error">{error}</p>}
        {notice && <p className="small badge badge-positive">{notice}</p>}

        <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6} data-testid="verify-submit">
          {busy ? t('auth.verifying') : t('auth.verifyAction')}
        </button>

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={cooldown > 0}
            onClick={resend}
            data-testid="resend-code"
          >
            {cooldown > 0 ? t('auth.resendIn', cooldown) : t('auth.resendCode')}
          </button>
          <Link className="small" href="/orders">
            {t('auth.skipForNow')}
          </Link>
        </div>
      </form>
    );
  }

  return (
    <form className="card card-pad stack" onSubmit={submit} data-testid="register-form">
      <div className="row" style={{ gap: 'var(--sp-3)' }}>
        <label className="field grow">
          <span className="label">{t('auth.firstName')}</span>
          <input
            className="input"
            autoComplete="given-name"
            value={form.firstName}
            onChange={(event) => update('firstName', event.target.value)}
          />
        </label>
        <label className="field grow">
          <span className="label">{t('auth.lastName')}</span>
          <input
            className="input"
            autoComplete="family-name"
            value={form.lastName}
            onChange={(event) => update('lastName', event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span className="label">{t('auth.email')}</span>
        <input
          type="email"
          className="input"
          required
          autoComplete="email"
          value={form.email}
          onChange={(event) => update('email', event.target.value)}
          placeholder="you@example.com"
        />
      </label>

      <label className="field">
        <span className="label">{t('auth.password')}</span>
        <input
          type="password"
          className="input"
          required
          minLength={8}
          autoComplete="new-password"
          value={form.password}
          onChange={(event) => update('password', event.target.value)}
        />
        <span className="tiny subtle">{t('auth.passwordHint')}</span>
      </label>

      {error && <p className="form-error">{error}</p>}

      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? t('auth.creatingAccount') : t('auth.createAccount')}
      </button>

      <p className="small muted center" style={{ margin: 0 }}>
        {t('auth.haveAccount')} <Link href="/login">{t('common.signIn')}</Link>
      </p>
    </form>
  );
}