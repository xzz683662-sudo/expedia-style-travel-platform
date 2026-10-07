import type { Metadata } from 'next';
import { ConsoleShell } from '@/components/ConsoleShell';
import { SupportInbox } from '@/components/SupportInbox';
import { resolveServerLocale } from '@/lib/i18n/config';
import { createTranslator } from '@/lib/i18n/dictionaries';

export const metadata: Metadata = {
  title: 'Live chat',
  robots: { index: false, follow: false },
};

/**
 * The support console's live-chat queue.
 *
 * A sibling of `/support` (customer lookup) rather than a tab inside it: an
 * agent answering a live chat and an agent editing a customer record are doing
 * different jobs, and the queue deserves the full width.
 */
export default async function SupportInboxPage() {
  const locale = await resolveServerLocale();
  const t = createTranslator(locale);

  return (
    <ConsoleShell
      surface="support"
      locale={locale}
      title={t('support.inbox')}
      subtitle={t('support.inboxSubtitle')}
    >
      <SupportInbox locale={locale} />
    </ConsoleShell>
  );
}
