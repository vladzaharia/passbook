import type { z } from 'zod';
import type { BrandKit, OrgBrand } from '../../../shared/contracts/brand.ts';
import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import { safeMail, safeUrl } from '../../email/safe.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { allowedMarks, effectiveMark } from './brand-mark.ts';
import { brandingKey, webLogoKey } from './branding-files.ts';
import { requireOrg } from './service.ts';

/** Content-addressed, same-origin path of a web logo. */
export const brandLogoPath = (orgId: string, sha: string) => `/brand/${orgId}/${sha}.png`;

/** Holder pages use the pass logo as the web logo: as chosen, else while no web logo is uploaded. */
export const webSameAsLogo = (chosen: boolean | undefined, stored: { web?: unknown }) =>
  chosen ?? !stored.web;

/**
 * The org's stored branding: validated (`{}` when it does not fit the schema) and as stored, which keeps
 * the fields the schema strips (an image's `storageVersion`).
 * Text that is not JSON is a corrupt row: logged with a stable code and thrown, never a raw SyntaxError.
 */
export function storedBrandingOf(
  ctx: ServiceContext,
  row: { id: string; branding: string },
): { stored: z.infer<typeof OrgBrandingSchema>; raw: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = JSON.parse(row.branding);
  } catch (error) {
    ctx.log.error('org.branding_unreadable', { orgId: row.id, code: 'BRANDING_UNREADABLE', error });
    throw new AppError('BRANDING_UNREADABLE', 500, 'The organization brand could not be read.', {
      cause: error,
    });
  }
  const parsed = OrgBrandingSchema.safeParse(raw);
  return parsed.success
    ? { stored: parsed.data, raw: raw as Record<string, unknown> }
    : { stored: {}, raw: {} };
}

/** Org settings win over the legacy branding fields; unsafe values are dropped. */
export async function orgBrandOf(ctx: ServiceContext, orgId: string): Promise<OrgBrand> {
  const [row, settings, allowed] = await Promise.all([
    requireOrg(ctx, orgId),
    getOrgSettings(ctx, orgId),
    allowedMarks(ctx, orgId),
  ]);
  const { stored } = storedBrandingOf(ctx, row);
  return {
    orgId,
    name: row.name,
    accent: stored.accent ?? settings['branding.accent'] ?? null,
    logo: shownLogo(orgId, stored, webSameAsLogo(settings['branding.webLogoSameAsLogo'], stored)),
    supportEmail: safeMail(settings['support.email'] ?? stored.supportEmail),
    supportUrl: safeUrl(settings['support.url'] ?? stored.supportUrl),
    mark: effectiveMark(stored.mark, allowed),
  };
}

/** The stored image holder pages show as the logo, and the R2 key of its bytes. */
export async function shownLogoKey(
  ctx: ServiceContext,
  orgId: string,
): Promise<{ sha: string; key: string } | null> {
  const [row, settings] = await Promise.all([requireOrg(ctx, orgId), getOrgSettings(ctx, orgId)]);
  if (row.status !== 'active') return null;
  const stored = storedBrandingOf(ctx, row).raw as {
    logo?: { sha: string; storageVersion?: string };
    web?: { sha: string };
  };
  if (webSameAsLogo(settings['branding.webLogoSameAsLogo'], stored) && stored.logo)
    return { sha: stored.logo.sha, key: brandingKey(orgId, 'logo', 3, stored.logo.storageVersion) };
  return stored.web ? { sha: stored.web.sha, key: webLogoKey(orgId, stored.web.sha) } : null;
}

/** The logo holder pages show: the pass logo when chosen and present, else the web logo. */
function shownLogo(orgId: string, stored: z.infer<typeof OrgBrandingSchema>, same: boolean) {
  const image = same && stored.logo ? stored.logo : stored.web;
  return image ? { path: brandLogoPath(orgId, image.sha), w: image.w, h: image.h } : null;
}

/** The brand kit DTO of the API and the admin section. */
export async function brandKitOf(ctx: ServiceContext, orgId: string): Promise<BrandKit> {
  const [brand, row, allowed] = await Promise.all([
    orgBrandOf(ctx, orgId),
    requireOrg(ctx, orgId),
    allowedMarks(ctx, orgId),
  ]);
  const { stored: chosen } = storedBrandingOf(ctx, row);
  return {
    orgId,
    name: brand.name,
    accent: brand.accent,
    webLogo: brand.logo ? { url: brand.logo.path, w: brand.logo.w, h: brand.logo.h } : null,
    supportEmail: brand.supportEmail,
    supportUrl: brand.supportUrl,
    mark: brand.mark,
    markChosen: chosen.mark ?? 'full',
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
