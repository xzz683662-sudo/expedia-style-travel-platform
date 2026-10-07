'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, readToken } from '@/lib/session';
import { api } from '@/lib/api';
import { NotificationCenter } from '@/components/NotificationCenter';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import { brandMark, brandName } from '@/lib/brand';

/**
 * Customer-facing header.
 *
 * Deliberately shows staff consoles only to staff. A customer should never see
 * an "Operator console" link — the route guards would reject them anyway, but a
 * visible dead end reads as broken product rather than as a permission boundary.
 */

const NAV = [
  { href: '/search', key: 'nav.experiences' },
  { href: '/cart', key: 'nav.cart' },
  { href: '/collections/trending', key: 'nav.trending' },
  { href: '/collections/free-cancellation', key: 'nav.freeCancellation' },
] as const;

const ACCOUNT_NAV = [
  { href: '/account', key: 'nav.myAccount' },
  { href: '/orders', key: 'nav.myOrders' },
  { href: '/tickets', key: 'nav.myTickets' },
  { href: '/wishlist', key: 'nav.wishlist' },
  { href: '/itineraries', key: 'nav.myItineraries' },
  { href: '/loyalty', key: 'nav.rewards' },
] as const;

/** Which console each staff role is allowed to reach. */
const STAFF_ROUTES: Record<string, { href: string; key: string }[]> = {
  ADMIN: [
    { href: '/admin', key: 'nav.operatorConsole' },
    { href: '/support', key: 'nav.supportConsole' },
  ],
  SUPPORT: [{ href: '/support', key: 'nav.supportConsole' }],
  OPERATOR: [{ href: '/admin/scan', key: 'nav.operatorConsole' }],
  MERCHANT: [{ href: '/admin', key: 'nav.operatorConsole' }],
};

export function Header({ locale }: { locale: LocaleCode }) {
  const pathname = usePathname();
  const t = createTranslator(locale);

  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const staffLinks = role ? (STAFF_ROUTES[role] ?? []) : [];

  // Close both menus on navigation — otherwise the mobile drawer stays open
  // over the page the shopper just asked for.
  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open, so the page behind it
  // doesn't scroll away under the shopper's thumb.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  // Read the session token after hydration. The header is a client component so
  // the shop can switch instantly between signed-in and signed-out states
  // without a full page load.
  useEffect(() => {
    const stored = readToken();
    if (!stored) return;
    setToken(stored);

    // Uses the shared client so the base URL and error handling stay in one
    // place instead of drifting from the rest of the app.
    api
      .me(stored)
      .then((profile) => {
        setName(profile.firstName);
        setRole(profile.role);
      })
      .catch(() => undefined);
  }, []);

  function signOut() {
    clearSession();
    setToken(null);
    setName(null);
    setRole(null);
    setOpen(false);
    setMenuOpen(false);
    window.location.href = '/';
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="header">
      <div className="header-inner">
        <Link href="/" className="logo" aria-label={`${brandName(locale)} — ${t('nav.home')}`}>
          <span className="logo-mark" aria-hidden>
            {brandMark(locale)}
          </span>
          <span>{brandName(locale)}</span>
        </Link>

        <button
          className="nav-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label={menuOpen ? t('nav.closeMenu') : t('nav.openMenu')}
        >
          <span className="nav-toggle-bars" aria-hidden />
        </button>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ color: isActive(item.href) ? 'var(--brand-700)' : undefined }}
            >
              {t(item.key)}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          {/* Present for everyone: signed-out visitors can still receive
              catalogue-wide signals, and the bell simply hides without a session. */}
          <NotificationCenter locale={locale} />

          {token ? (
            <div style={{ position: 'relative' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="menu"
              >
                <span
                  aria-hidden
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: 'var(--brand-600)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {(name ?? 'Y').charAt(0).toUpperCase()}
                </span>
                <span className="nowrap header-account-name">{name ?? t('common.account')}</span>
              </button>

              {open && (
                <div
                  role="menu"
                  className="card"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 8px)',
                    minWidth: 200,
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 60,
                  }}
                >
                  <div className="stack-sm" style={{ padding: 'var(--sp-2)' }}>
                    {ACCOUNT_NAV.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        className="small"
                        style={{ padding: '8px 10px', borderRadius: 'var(--r-sm)' }}
                        onClick={() => setOpen(false)}
                        role="menuitem"
                      >
                        {t(item.key)}
                      </Link>
                    ))}

                    {/* Staff links are role-filtered — a customer never sees these. */}
                    {staffLinks.length > 0 && (
                      <>
                        <hr className="divider" style={{ margin: '4px 0' }} />
                        {staffLinks.map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className="small"
                            style={{ padding: '8px 10px', borderRadius: 'var(--r-sm)', color: 'var(--brand-700)' }}
                            onClick={() => setOpen(false)}
                            role="menuitem"
                          >
                            {t(item.key)}
                          </Link>
                        ))}
                      </>
                    )}

                    <hr className="divider" style={{ margin: '4px 0' }} />
                    <button type="button" className="account-signout" onClick={signOut} role="menuitem">
                      {t('common.signOut')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost btn-sm">
                {t('common.signIn')}
              </Link>
              <Link href="/register" className="btn btn-primary btn-sm">
                {t('common.joinFree')}
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Mobile drawer. Rendered unconditionally and toggled by class so the
          open/close transition isn't gated on a React state flip mid-animation. */}
      <nav
        id="mobile-nav"
        className={`nav-mobile ${menuOpen ? 'open' : ''}`}
        aria-label="Mobile"
        hidden={!menuOpen}
      >
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className={isActive(item.href) ? 'active' : ''}>
            {t(item.key)}
          </Link>
        ))}

        {token && (
          <>
            <hr className="divider" style={{ margin: 'var(--sp-2) 0' }} />
            {ACCOUNT_NAV.map((item) => (
              <Link key={item.href} href={item.href} className={isActive(item.href) ? 'active' : ''}>
                {t(item.key)}
              </Link>
            ))}

            {staffLinks.length > 0 && (
              <>
                <hr className="divider" style={{ margin: 'var(--sp-2) 0' }} />
                {staffLinks.map((item) => (
                  <Link key={item.href} href={item.href} className="staff-link">
                    {t(item.key)}
                  </Link>
                ))}
              </>
            )}

            <button type="button" className="signout-link" onClick={signOut}>
              {t('common.signOut')}
            </button>
          </>
        )}

        {!token && (
          <>
            <hr className="divider" style={{ margin: 'var(--sp-2) 0' }} />
            <Link href="/login" className="active">
              {t('common.signIn')}
            </Link>
            <Link href="/register">{t('common.joinFree')}</Link>
          </>
        )}
      </nav>
    </header>
  );
}