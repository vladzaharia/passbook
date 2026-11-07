import type { CSSProperties } from 'react';
import { type ReactNode, useState } from 'react';
import type { ScanBranding, ScanSession } from '../../../shared/contracts/scan-session.ts';

type BrandStyle = CSSProperties & { '--scan-org-accent'?: string };

export function scanBrandStyle(branding: ScanBranding | null | undefined): BrandStyle | undefined {
  return branding?.accent ? { '--scan-org-accent': branding.accent } : undefined;
}

export function scanBrandLogoUrl(
  branding: ScanBranding | null | undefined,
  session?: ScanSession,
): string | null {
  if (!branding?.logo) return null;
  const query = new URLSearchParams({ v: branding.logo.sha });
  if (session?.principal === 'admin') {
    const scope = new URLSearchParams(location.search);
    for (const key of ['orgId', 'eventId', 'templateIds', 'setupId', 'timeZone']) {
      const value = scope.get(key);
      if (value) query.set(key, value);
    }
  }
  return `/api/v1/scan/branding/logo?${query}`;
}

export function ScanOrgLogo({
  src,
  name,
  className,
  fallback = null,
}: {
  src: string | null;
  name: string;
  className: string;
  fallback?: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return fallback;
  return (
    <img
      className={className}
      src={src}
      alt={name ? `${name} logo` : 'Organization logo'}
      onError={() => setFailedSrc(src)}
    />
  );
}
