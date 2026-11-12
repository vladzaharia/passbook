import type { CSSProperties } from 'react';
import { type ReactNode, useEffect, useState } from 'react';
import type { ScanBranding, ScanSession } from '../../../shared/contracts/scan-session.ts';

type BrandStyle = CSSProperties & { '--scan-org-accent'?: string };

const LOGO_RETRY_MS = 15_000;
const LOGO_RETRIES = 3;

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
  const [failed, setFailed] = useState<{ src: string; count: number; waiting: boolean } | null>(
    null,
  );
  const failures = failed?.src === src ? failed : null;
  // A refused logo (a 409 after a configuration change, say) is never a sign-out: show the
  // fallback and try again a little later, a few times.
  useEffect(() => {
    if (!failures?.waiting || failures.count > LOGO_RETRIES) return;
    const timer = setTimeout(
      () =>
        setFailed((current) => (current === failures ? { ...current, waiting: false } : current)),
      LOGO_RETRY_MS,
    );
    return () => clearTimeout(timer);
  }, [failures]);
  if (!src || failures?.waiting) return fallback;
  const attempt = failures?.count ?? 0;
  return (
    <img
      className={className}
      src={attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src}
      alt={name ? `${name} logo` : 'Organization logo'}
      onError={() => setFailed({ src, count: attempt + 1, waiting: true })}
    />
  );
}
