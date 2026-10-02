import type { Metadata } from 'next';
import { ItineraryExperience } from '@/components/ItineraryExperience';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return { title: t('travel.plansTitle'), robots: { index: false } };
}

export default async function ItinerariesPage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-6)', paddingBottom: 'var(--sp-7)' }}>
      <h1>{t('travel.plansTitle')}</h1>
      <p className="muted" style={{ marginBottom: 'var(--sp-5)' }}>{t('travel.plansSubtitle')}</p>
      <ItineraryExperience locale={locale} />
    </div>
  );
}
