import type { Metadata } from 'next';
import { CartView } from '@/components/CartExperience';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return { title: t('cart.title'), robots: { index: false } };
}

export default async function CartPage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return (
    <div className="container stack" style={{ padding: 'var(--sp-6) 0 var(--sp-7)' }}>
      <header>
        <h1 style={{ marginBottom: 'var(--sp-2)' }}>{t('cart.title')}</h1>
        <p className="muted">{t('cart.subtitle')}</p>
      </header>
      <CartView locale={locale} />
    </div>
  );
}
