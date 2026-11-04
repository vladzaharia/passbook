import { z } from 'zod';
import type { PassJson } from '../../../passkit/types.ts';
import type { BrandingImageRef } from '../orgs/branding-files.ts';

/**
 * The org's pass branding, read leniently from `orgs.branding` (shape owned by the orgs module):
 * `passColors` override the template colours, `logoHasName` drops logoText, and the uploaded
 * `logo` and `icon` (files in R2, see `brandingFiles`) replace the template's.
 */
const SLOTS = ['logo', 'icon'] as const;
const Color = z
  .string()
  .regex(/^(#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i);
const Image = z.object({
  sha: z.string().min(1),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
const BrandingSchema = z.object({
  logoHasName: z.boolean().optional().catch(undefined),
  passColors: z
    .object({
      background: Color.optional(),
      foreground: Color.optional(),
      label: Color.optional(),
    })
    .optional()
    .catch(undefined),
  logo: Image.optional().catch(undefined),
  icon: Image.optional().catch(undefined),
});

export interface TenantBranding {
  logoHasName: boolean;
  colors: { background?: string; foreground?: string; label?: string } | null;
  /** The uploaded logo and icon; their files come from `brandingFiles`. */
  images: BrandingImageRef[];
}

export function readBranding(raw: unknown): TenantBranding {
  const parsed = BrandingSchema.safeParse(raw ?? {});
  const b = parsed.success ? parsed.data : {};
  const colors = b.passColors && Object.keys(b.passColors).length > 0 ? b.passColors : null;
  return {
    logoHasName: b.logoHasName === true,
    colors,
    images: SLOTS.flatMap((slot) => {
      const image = b[slot];
      return image ? [{ slot, ...image }] : [];
    }),
  };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "Store card" for "Northwind Climbing" -> "Northwind Climbing store card"; own names stay. */
export function tenantDescription(description: unknown, orgName: string): string | undefined {
  if (typeof description !== 'string' || !description.trim()) return undefined;
  const kind = description.trim().replace(/^wallet\s+/i, '');
  if (kind.toLowerCase().includes(orgName.toLowerCase())) return kind;
  return `${orgName} ${lowerFirst(kind)}`;
}

/** The template's pass.json with the tenant's name, description and colours applied. */
export function tenantPassJson(
  base: PassJson,
  orgName: string,
  branding: TenantBranding,
): PassJson {
  const pass: PassJson = { ...base };
  for (const key of ['logoText', 'eventLogoText'] as const) {
    if (typeof pass[key] !== 'string') continue;
    if (branding.logoHasName) delete pass[key];
    else pass[key] = orgName;
  }
  const description = tenantDescription(pass.description, orgName);
  if (description) pass.description = description;
  if (branding.colors?.background) pass.backgroundColor = branding.colors.background;
  if (branding.colors?.foreground) pass.foregroundColor = branding.colors.foreground;
  if (branding.colors?.label) pass.labelColor = branding.colors.label;
  return pass;
}

/** Starter templates ship placeholder logo and icon art that tenants must replace. */
export const isStarterTemplate = (templateId: string) => templateId.startsWith('baked:starter-');

const slotOfName = (name: string) => name.replace(/(@[23]x)?\.png$/, '');

/**
 * PLATFORM_BRANDING when a tenant pass would ship a starter's logo or icon: neither the org
 * branding nor a per-pass override replaces it.
 */
export function brandingWarnings(
  templateId: string,
  branding: TenantBranding,
  overrideNames: readonly string[],
): { severity: 'warning'; code: string; message: string; path?: string }[] {
  if (!isStarterTemplate(templateId)) return [];
  const replaced = new Set([
    ...branding.images.map((i) => i.slot),
    ...overrideNames.map(slotOfName),
  ]);
  const missing = SLOTS.filter((slot) => !replaced.has(slot));
  if (missing.length === 0) return [];
  return [
    {
      severity: 'warning',
      code: 'PLATFORM_BRANDING',
      message: `Uses the starter ${missing.join(' and ')}. Add the organization's ${missing.join(' and ')} in Pass branding.`,
      path: missing[0],
    },
  ];
}
