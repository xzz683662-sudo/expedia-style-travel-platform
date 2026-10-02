import Link from 'next/link';
import type { LocaleCode } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import { brandMark, brandName } from '@/lib/brand';

/**
 * Customer-facing footer.
 *
 * No staff links. Staff reach their consoles from the account menu, which is
 * role-gated — a public footer is the one place where an operations link is
 * guaranteed to be seen by every visitor, customers included.
 */

const GROUPS = [
  {
    titleKey: 'nav.experiences' as const,
    items: [
      { key: 'nav.experiences' as const, href: '/search' },
      { key: 'nav.cart' as const, href: '/cart' },
      { key: 'nav.trending' as const, href: '/collections/trending' },
      { key: 'home.skipTheLine' as const, href: '/collections/skip-the-line' },
      { key: 'nav.freeCancellation' as const, href: '/collections/free-cancellation' },
    ],
  },
  {
    titleKey: 'account.myBookings' as const,
    items: [
      { key: 'nav.myOrders' as const, href: '/orders' },
      { key: 'nav.myTickets' as const, href: '/tickets' },
      { key: 'nav.rewards' as const, href: '/loyalty' },
    ],
  },
  {
    titleKey: 'footer.support' as const,
    items: [
      { key: 'footer.helpCentre' as const, href: '/search' },
      { key: 'footer.cancellations' as const, href: '/orders' },
      { key: 'footer.contact' as const, href: '/login' },
    ],
  },
] as const;

export function Footer({ locale }: { locale: LocaleCode }) {
  const t = createTranslator(locale);

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="stack-sm">
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <span className="logo-mark" aria-hidden>
                {brandMark(locale)}
              </span>
              <span className="bold" style={{ fontSize: 17 }}>
                {brandName(locale)}
              </span>
            </div>
            <p style={{ maxWidth: 340 }}>{t('footer.aboutText')}</p>
            <p className="tiny subtle">
              {locale === 'zh'
                ? '演示环境：支付走内置模拟网关，不会产生真实扣款。'
                : 'Demo platform. Payments run against a built-in mock gateway — no real charges are made.'}
            </p>
          </div>

          {GROUPS.map((group) => (
            <div key={group.titleKey} className="stack-sm">
              <h4 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t(group.titleKey)}
              </h4>
              {group.items.map((item) => (
                <Link key={item.href + item.key} href={item.href} className="small">
                  {t(item.key)}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <hr className="divider" />

        <div className="row-between wrap small subtle">
          <span>
            © {new Date().getFullYear()} {brandName(locale)}. {t('footer.rights')}
          </span>
          <div className="row wrap" style={{ gap: 'var(--sp-4)' }}>
            <Link href="/search" className="small subtle">
              {t('footer.privacy')}
            </Link>
            <Link href="/search" className="small subtle">
              {t('footer.terms')}
            </Link>
            <span>{t('nav.priceNotice')}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}