'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { readToken, clearSession } from '@/lib/session';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { createTranslator } from '@/lib/i18n/dictionaries';
import type { LocaleCode } from '@/lib/i18n/config';
import { brandMark, brandName } from '@/lib/brand';

/**
 * Shared chrome for the two staff consoles.
 *
 * Each console gets its own colour identity (admin = brand blue, support =
 * teal) so an operator working across a support handover can tell at a glance
 * which surface they are in — the cheapest possible guard against acting in
 * the wrong system.
 */

type Surface = {
  href: string;
  labelKey: string;
};

const ADMIN_NAV: Surface[] = [
  { href: '/admin', labelKey: 'staff.dashboard' },
  { href: '/admin/finance', labelKey: 'staff.finance' },
  { href: '/admin/scan', labelKey: 'staff.gateScanner' },
  { href: '/admin/promo', labelKey: 'promo.adminTitle' },
];

const SUPPORT_NAV: Surface[] = [
  // Live chat first: it is the one support surface with a customer waiting on
  // the other end, so it should be the page an agent lands on.
  { href: '/support/inbox', labelKey: 'support.inbox' },
  { href: '/support', labelKey: 'support.customers' },
  { href: '/support/orders', labelKey: 'support.orders' },
  { href: '/support/coupons', labelKey: 'support.coupons' },
  { href: '/support/audit', labelKey: 'support.audit' },
];

const ROLE_ACCESS: Record<string, { surface: 'admin' | 'support'; nav: Surface[] }> = {
  ADMIN: { surface: 'admin', nav: ADMIN_NAV },
  SUPPORT: { surface: 'support', nav: SUPPORT_NAV },
};

export function ConsoleShell({
  surface,
  title,
  subtitle,
  locale,
  children,
}: {
  surface: 'admin' | 'support';
  title: string;
  subtitle: string;
  locale: LocaleCode;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const t = createTranslator(locale);

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readToken();
    if (!stored) {
      router.replace(`/login?next=${encodeURIComponent(surface === 'admin' ? '/admin' : '/support')}`);
      return;
    }
    setToken(stored);

    api
      .me(stored)
      .then((profile) => {
        setRole(profile.role);
        setReady(true);
      })
      .catch(() => clearSession());
  }, [router, surface]);

  function signOut() {
    clearSession();
    window.location.href = '/';
  }

  const access = role ? ROLE_ACCESS[role] : null;
  const allowed = access?.surface === surface;

  if (!token) return <div className="skeleton" style={{ height: 320 }} />;

  if (ready && !allowed) {
    return (
      <div className="empty-state" style={{ paddingTop: 'var(--sp-8)' }}>
        <h3>{t('staff.staffOnly')}</h3>
        <p className="muted" style={{ maxWidth: 420 }}>
          {t('staff.staffOnlyHint')}
        </p>
        <Link href="/" className="btn btn-primary">
          {brandName(locale)}
        </Link>
      </div>
    );
  }

  const nav = access?.nav ?? [];

  return (
    <div className={`console console-${surface}`}>
      <aside className="console-nav">
        <div className="console-brand">
          <span className="logo-mark" aria-hidden>
            {brandMark(locale)}
          </span>
          <div className="stack-sm" style={{ gap: 0 }}>
            <span className="bold" style={{ fontSize: 15 }}>
              {brandName(locale)}
            </span>
            <span className="tiny" style={{ opacity: 0.65 }}>
              {surface === 'admin' ? t('staff.operations') : t('support.console')}
            </span>
          </div>
        </div>

        <nav className="console-links">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`console-link ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        <div className="console-foot">
          <Link href="/" className="console-link">
            ← {t('nav.experiences')}
          </Link>
          <button className="console-link" onClick={signOut}>
            {t('common.signOut')}
          </button>
        </div>
      </aside>

      <div className="console-main">
        <header className="console-header">
          <div className="console-header-row">
            <div>
              <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
              <p className="small muted" style={{ margin: '2px 0 0' }}>
                {subtitle}
              </p>
            </div>

            {/* The storefront locale bar is hidden inside the console (see the
                `body:has(.console-root)` rule), so staff need their own toggle
                or they are stuck in whatever language the cookie happens to
                hold. */}
            <LocaleSwitcher locale={locale} />
          </div>
        </header>

        <div className="console-body">{children}</div>
      </div>
    </div>
  );
}