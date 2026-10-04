import { redirect } from 'next/navigation';
import { CartCheckoutFlow } from '@/components/CartExperience';
import { CheckoutFlow } from '@/components/CheckoutFlow';
import { resolveServerLocale } from '@/lib/i18n/config';

/**
 * The checkout itself is a client flow (it holds payment state), but the slug
 * is read on the server so we can redirect early and keep the component clean.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const cart = Array.isArray(params.cart) ? params.cart[0] : params.cart;

  const locale = await resolveServerLocale();
  if (cart === '1') return <CartCheckoutFlow locale={locale} />;
  if (!slug) redirect('/search');
  return <CheckoutFlow slug={slug} locale={locale} />;
}