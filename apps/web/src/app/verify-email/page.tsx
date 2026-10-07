import type { Metadata } from 'next';
import { VerifyEmailForm } from '@/components/VerifyEmailForm';
import { resolveServerLocale } from '@/lib/i18n/config';

export const metadata: Metadata = {
  robots: { index: false },
};

/**
 * Landing page for the header's "verify your email" banner.
 *
 * Kept out of the register flow on purpose: registration is a one-time act,
 * whereas confirming an address can happen days later, from a different device,
 * after the original tab is long gone.
 */
export default async function VerifyEmailPage() {
  const locale = await resolveServerLocale();

  return (
    <div className="container" style={{ paddingTop: 'var(--sp-7)', paddingBottom: 'var(--sp-7)' }}>
      <div style={{ maxWidth: 420, margin: '0 auto' }}>
        <VerifyEmailForm locale={locale} />
      </div>
    </div>
  );
}
