/**
 * Minimal i18n layer.
 *
 * No framework — the app has ~120 UI strings, which a runtime library would
 * outweigh. Keys are dot-paths into nested objects so a missing key produces
 * `a.b.c` instead of `undefined`, which makes gaps obvious in the UI.
 *
 * Locale is resolved in this order:
 *   1. explicit `?lang=` (used by the switcher)
 *   2. cookie (set by the switcher, survives reload)
 *   3. the signed-in user's saved locale
 *   4. Accept-Language
 *   5. English
 */

export const LOCALES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'zh', label: '中文', short: '中文' },
] as const;

export type LocaleCode = (typeof LOCALES)[number]['code'];

export const DEFAULT_LOCALE: LocaleCode = 'en';

export const LOCALE_COOKIE = 'easytrip_lang';

/**
 * The BCP-47 tag for `<html lang>` and for native controls.
 *
 * A `<input type="date">` renders its format placeholder in the *browser's*
 * locale, not the page's — so an English page opened in a Chinese-locale browser
 * shows `年月日` where every other string is English. Setting `lang` on the input
 * is what fixes it (verified in Chromium: `lang="en-US"` renders `yyyy/mm/dd`).
 * Drives both the document and each date input from one helper so they cannot
 * disagree.
 */
export function htmlLang(locale: LocaleCode): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

export function isLocale(value: string | undefined | null): value is LocaleCode {
  return LOCALES.some((l) => l.code === value);
}

/**
 * Maps an API locale (`en-US`, `zh-CN`) onto a UI locale (`en`, `zh`).
 * Anything we don't ship falls back to English rather than rendering blanks.
 */
export function normaliseLocale(raw: string | undefined | null): LocaleCode {
  if (!raw) return DEFAULT_LOCALE;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/** Reads Accept-Language and picks the best match. */
export function fromAcceptLanguage(header: string | null | undefined): LocaleCode {
  if (!header) return DEFAULT_LOCALE;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: tag.trim(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolves the active locale on the server.
 *
 * Reads cookies via `next/headers`. Kept in its own module so client
 * components can import the pure helpers above without pulling in `next/headers`.
 */
export async function resolveServerLocale(): Promise<LocaleCode> {
  const { cookies, headers } = await import('next/headers');

  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;

  const header = (await headers()).get('accept-language');
  return fromAcceptLanguage(header);
}