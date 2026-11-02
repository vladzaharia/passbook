import { z } from 'zod';
import type { PassJson } from '../../../passkit/types.ts';
import type { AssetRow } from './repo.ts';

/**
 * The org's pass branding, read leniently from `orgs.branding` (shape owned by the orgs module):
 * `passColors` override the template colours, `logoHasName` drops logoText, and `images` maps
 * `logo@2x.png`-style names to stored PNGs that replace the template's logo and icon.
 */
const Color = z
  .string()
  .regex(/^(#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i);
const Image = z.object({
  key: z.string().min(1),
  sha1: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().positive(),
  crc32: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
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
  images: z
    .record(z.string().regex(/^(logo|icon)(@[23]x)?\.png$/), Image)
    .optional()
    .catch(undefined),
});

export interface TenantBranding {
  logoHasName: boolean;
  colors: { background?: string; foreground?: string; label?: string } | null;
  /** Branding images as asset rows, in the same shape as per-pass overrides. */
  images: AssetRow[];
}

export function readBranding(raw: unknown): TenantBranding {
  const parsed = BrandingSchema.safeParse(raw ?? {});
  const b = parsed.success ? parsed.data : {};
  const colors = b.passColors && Object.keys(b.passColors).length > 0 ? b.passColors : null;
  return {
    logoHasName: b.logoHasName === true,
    colors,
    images: Object.entries(b.images ?? {}).map(([name, img]) => ({
      name,
      r2Key: img.key,
      sha1: img.sha1,
      size: img.size,
      width: img.width ?? null,
      height: img.height ?? null,
      crc32: img.crc32 ?? null,
      createdAt: 0,
    })),
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

const SLOTS = ['logo', 'icon'] as const;
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
  const replaced = new Set(
    [...branding.images.map((i) => i.name), ...overrideNames].map(slotOfName),
  );
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
