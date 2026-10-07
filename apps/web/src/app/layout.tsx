import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { RealtimeProvider } from '@/components/RealtimeProvider';
import { SupportWidget } from '@/components/SupportWidget';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';
import { brandName, brandTagline } from '@/lib/brand';

/**
 * Metadata is generated per-request so the brand name, the page title and the
 * description all land in the right language on the very first paint. A static
 * `metadata` export cannot do this: `zh` must render 易捷旅行 while every other
 * locale renders EasyTrip, and the two titles differ.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const brand = brandName(locale);
  const zh = locale === 'zh';
  // Open Graph wants a regional tag (`zh_CN`), which is unrelated to the UI's
  // bare `LocaleCode` union — hence a plain string rather than that type.
  const ogLocale = zh ? 'zh_CN' : 'en_US';

  return {
    title: {
      default: zh
        ? `${brand} — 全球机票、酒店、邮轮与精选体验`
        : `${brand} — Flights, hotels, cruises and curated experiences worldwide`,
      template: `%s | ${brand}`,
    },
    description: zh
      ? '易捷旅行甄选全球国际机票、五星酒店、邮轮与河轮、私人向导与殿堂级景点。下单即刻确认，退改灵活，行程由走过这条路的人亲自安排。'
      : 'EasyTrip curates international flights, five-star hotels, ocean and river cruises, private guides and landmark access worldwide. Confirmed the moment you book, flexible terms, and journeys arranged by people who have travelled them.',
    applicationName: brand,
    keywords: zh
      ? ['国际机票', '五星酒店', '邮轮', '河轮', '私人导游', '精选体验', '易捷旅行', '旅游']
      : ['international flights', 'luxury hotels', 'cruises', 'river cruises', 'private guides', 'curated experiences', 'EasyTrip', 'travel'],
    authors: [{ name: brand }],
    creator: brand,
    openGraph: {
      type: 'website',
      siteName: brand,
      title: zh
        ? `${brand} — 全球机票、酒店、邮轮与精选体验`
        : `${brand} — Flights, hotels, cruises and curated experiences worldwide`,
      description: zh
        ? '易捷旅行甄选全球国际机票、五星酒店、邮轮与私人体验，下单即刻确认。'
        : 'EasyTrip curates international flights, five-star hotels, cruises and private experiences worldwide — confirmed the moment you book.',
      locale: ogLocale,
    },
    twitter: {
      card: 'summary_large_image',
      title: zh ? `${brand} — 全球精选旅行` : `${brand} — Curated travel, worldwide`,
      description: brandTagline(locale),
    },
    formatDetection: { telephone: false },
  };
}

/**
 * `viewport-fit=cover` lets the sticky CTA and safe-area padding work on
 * notched devices; `viewport-fit` alone is not enough without a
 * `padding-bottom: env(safe-area-inset-bottom)` on the fixed bar.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is left enabled on purpose — pinching to read a booking reference or
  // a QR code is a real need. We prevent *accidental* zoom instead, via
  // touch-action on interactive controls, rather than capping the scale.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved per-request on the server so the first paint is already in the
  // right language — no flash of English before hydration swaps it.
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  return (
    <html lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <body>
        <a className="skip-link" href="#main">
          {t('nav.skipToContent')}
        </a>
        {/* One realtime connection per tab, shared by the notification centre,
            the order pages and the operator console. */}
        <RealtimeProvider>
          <div className="locale-bar">
            <div className="container locale-bar-inner">
              <span className="locale-bar-text">{t('nav.priceNotice')}</span>
              <LocaleSwitcher locale={locale} />
            </div>
          </div>
          <Header locale={locale} />
          <main id="main">{children}</main>
          <Footer locale={locale} />
          {/* The shopper's end of the support chat. It hides itself inside the
              staff consoles, so mounting it once here is safe. */}
          <SupportWidget locale={locale} />
        </RealtimeProvider>
      </body>
    </html>
  );
}