import type { Metadata } from 'next';
import { AccountCenter } from '@/components/AccountCenter';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

/**
 * My account — profile, stored-value balance, saved payment methods and travel
 * documents.
 *
 * `robots: noindex`: it is per-user and shows nothing a search engine should
 * index even when signed out.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);
  return { title: t('account.centerTitle'), robots: { index: false } };
}

export default async function AccountPage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-6)', paddingBottom: 'var(--sp-7)' }}>
      <h1 style={{ marginBottom: 4 }}>{t('account.centerTitle')}</h1>
      <p className="muted" style={{ marginBottom: 'var(--sp-5)' }}>{t('account.centerSubtitle')}</p>
      <AccountCenter locale={locale} />
    </div>
  );
}
