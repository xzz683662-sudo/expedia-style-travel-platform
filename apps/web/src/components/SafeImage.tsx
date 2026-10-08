'use client';

import { useState } from 'react';

/**
 * An `<img>` that degrades instead of showing a broken-image icon.
 *
 * Why a plain `<img>` and not `next/image`: the catalogue draws from partner
 * CDNs as well as our own, and the image optimiser would need every one of them
 * allow-listed in `next.config.ts`. A plain tag keeps the build dependency-free;
 * this component adds the one thing it lacks — a failure path.
 *
 * Why it matters beyond cosmetics: several cards put white text *over* the
 * image. When the image fails, the white text lands on the card's light grey
 * background and becomes unreadable, which is exactly the defect this fixes.
 */
export function SafeImage({
  src,
  alt,
  className,
  style,
  loading = 'lazy',
  fallback,
  'data-testid': testId,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'lazy' | 'eager';
  /** Rendered instead of the image. Callers style it to fill the same box. */
  fallback: React.ReactNode;
  'data-testid'?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return <>{fallback}</>;

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      data-testid={testId}
      onError={() => setFailed(true)}
    />
  );
}
