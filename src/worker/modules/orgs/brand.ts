import type { z } from 'zod';
import type { BrandKit, OrgBrand } from '../../../shared/contracts/brand.ts';
import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import { safeMail, safeUrl } from '../../email/safe.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { allowedMarks, effectiveMark } from './brand-mark.ts';
import { requireOrg } from './service.ts';

/** Content-addressed, same-origin path of a web logo. */
export const brandLogoPath = (orgId: string, sha: string) => `/brand/${orgId}/${sha}.png`;

/** Org settings win over the legacy branding fields; unsafe values are dropped. */
export async function orgBrandOf(ctx: ServiceContext, orgId: string): Promise<OrgBrand> {
  const [row, settings, allowed] = await Promise.all([
    requireOrg(ctx, orgId),
    getOrgSettings(ctx, orgId),
    allowedMarks(ctx, orgId),
  ]);
  const parsed = OrgBrandingSchema.safeParse(JSON.parse(row.branding));
  const stored = parsed.success ? parsed.data : {};
  return {
    orgId,
    name: row.name,
    accent: stored.accent ?? settings['branding.accent'] ?? null,
    logo: stored.web
      ? { path: brandLogoPath(orgId, stored.web.sha), w: stored.web.w, h: stored.web.h }
      : null,
    supportEmail: safeMail(settings['support.email'] ?? stored.supportEmail),
    supportUrl: safeUrl(settings['support.url'] ?? stored.supportUrl),
    mark: effectiveMark(stored.mark, allowed),
  };
}

/** The brand kit DTO of the API and the admin section. */
export async function brandKitOf(ctx: ServiceContext, orgId: string): Promise<BrandKit> {
  const [brand, row, allowed] = await Promise.all([
    orgBrandOf(ctx, orgId),
    requireOrg(ctx, orgId),
    allowedMarks(ctx, orgId),
  ]);
  const chosen = OrgBrandingSchema.safeParse(JSON.parse(row.branding));
  return {
    orgId,
    name: brand.name,
    accent: brand.accent,
    webLogo: brand.logo ? { url: brand.logo.path, w: brand.logo.w, h: brand.logo.h } : null,
    supportEmail: brand.supportEmail,
    supportUrl: brand.supportUrl,
    mark: brand.mark,
    markChosen: (chosen.success ? chosen.data.mark : undefined) ?? 'full',
    markAllowed: [...allowed],
    configRevision: row.config_revision,
  };
}

/**
 * The logo the scanner screens default to: the web logo, else the pass logo. `slot` says which
 * R2 object holds it. Pure, so the scan session and its logo route agree.
 */
export function scanLogoOf(
  stored: Pick<z.infer<typeof OrgBrandingSchema>, 'web' | 'logo'>,
): { slot: 'web' | 'logo'; image: NonNullable<z.infer<typeof OrgBrandingSchema>['web']> } | null {
  if (stored.web) return { slot: 'web', image: stored.web };
  return stored.logo ? { slot: 'logo', image: stored.logo } : null;
}
