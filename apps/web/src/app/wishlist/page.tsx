import type { Metadata } from 'next';
import { WishlistExperience } from '@/components/WishlistExperience';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return { title: t('travel.wishlistTitle'), robots: { index: false } };
}

export default async function WishlistPage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-6)', paddingBottom: 'var(--sp-7)' }}>
      <h1>{t('travel.wishlistTitle')}</h1>
      <p className="muted" style={{ marginBottom: 'var(--sp-5)' }}>{t('travel.wishlistSubtitle')}</p>
      <WishlistExperience locale={locale} />
    </div>
  );
}
