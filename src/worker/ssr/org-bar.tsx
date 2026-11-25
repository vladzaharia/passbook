import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgBrand } from '../../shared/contracts/brand.ts';
import { passbookCredit } from '../../shared/copy/passbook-credit.ts';
import { BrandMark } from '../../web/ui/layout/brand-mark.tsx';

/** The logo drawn at most this big: a bar's height, and a width that leaves the page room. */
const LOGO_MAX = { h: 32, w: 176 };

/** The web logo at its display size, or the org's name when it has no logo. */
export function OrgLogo({ brand, max = LOGO_MAX }: { brand: OrgBrand; max?: typeof LOGO_MAX }) {
  const logo = brand.logo;
  if (!logo) return <span className="org-name">{brand.name}</span>;
  const scale = Math.min(1, max.h / logo.h, max.w / logo.w);
  return (
    <img
      className="org-logo"
      src={logo.path}
      alt={brand.name}
      width={Math.max(1, Math.round(logo.w * scale))}
      height={Math.max(1, Math.round(logo.h * scale))}
      decoding="async"
    />
  );
}

/**
 * The org's bar on hosted pages (AppShell's: 56 px with its border, sticky, page surface). It
 * carries the web logo, else the org's name; a pass's icon is a notification square drawn per
 * pass, never the org's mark.
 */
export function OrgBar({ orgName, brand }: { orgName: string; brand?: OrgBrand | undefined }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-[calc(3.5rem-1px)] w-full max-w-5xl items-center px-safe">
        {brand?.logo ? (
          <OrgLogo brand={brand} />
        ) : (
          <span className="min-w-0 truncate text-base font-semibold text-fg-strong">{orgName}</span>
        )}
      </div>
    </header>
  );
}

/**
 * The PassBook mark at the foot of an org's page: `full` is the wordmark, `small` one quiet line,
 * `none` nothing. Legal and report links are separate and never depend on it.
 */
export function OrgMark({ brand }: { brand?: OrgBrand | undefined }) {
  const credit = passbookCredit(brand?.mark);
  if (!credit) return null;
  return (
    <footer className="org-mark">
      <span>{credit.lead}</span>
      {credit.name && (
        <b>
          <BrandMark />
          {credit.name}
        </b>
      )}
    </footer>
  );
}

export const orgLogoHtml = (brand: OrgBrand) =>
  renderToStaticMarkup(<OrgLogo brand={brand} max={{ h: 40, w: 200 }} />);
export const orgMarkHtml = (brand: OrgBrand | undefined) =>
  renderToStaticMarkup(<OrgMark brand={brand} />);
