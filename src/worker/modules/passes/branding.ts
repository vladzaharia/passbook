import { z } from 'zod';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { type BrandPartName, ownBrandParts } from '../../../passkit/template/brand.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { BrandingImageRef } from '../orgs/branding-files.ts';
import { sourceBlueprintAssets } from './repo-blueprint-art.ts';

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
  // Internal R2 object version; older branding rows use the legacy stable key.
  storageVersion: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
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

/**
 * The template's pass.json with the tenant's name, description and colours applied. A personal org
 * keeps the template's own logoText and description (see `issuerName`); its colours still apply.
 */
export function tenantPassJson(
  base: PassJson,
  orgName: string,
  branding: TenantBranding,
  personal = false,
): PassJson {
  const pass: PassJson = { ...base };
  for (const key of personal ? [] : (['logoText', 'eventLogoText'] as const)) {
    if (typeof pass[key] !== 'string') continue;
    if (branding.logoHasName) delete pass[key];
    else pass[key] = orgName;
  }
  const description = personal ? undefined : tenantDescription(pass.description, orgName);
  if (description) pass.description = description;
  if (branding.colors?.background) pass.backgroundColor = branding.colors.background;
  if (branding.colors?.foreground) pass.foregroundColor = branding.colors.foreground;
  if (branding.colors?.label) pass.labelColor = branding.colors.label;
  return pass;
}

/**
 * The org's branding as one template takes it: a part the template's `brand` block keeps its own of
 * is left out, so the template's colours or image stand. No block: the branding unchanged.
 */
export function appliedBranding(
  branding: TenantBranding,
  manifest?: Pick<TemplateManifest, 'brand'> | null,
): TenantBranding {
  const own: readonly BrandPartName[] = ownBrandParts(manifest);
  if (own.length === 0) return branding;
  return {
    ...branding,
    colors: own.includes('colors') ? null : branding.colors,
    images: branding.images.filter((i) => !(own as readonly string[]).includes(i.slot)),
  };
}

/**
 * Blueprints ship placeholder logo and icon art that tenants must replace. A template made from a
 * blueprint carries the same files, so their hashes find it where an id cannot.
 */
let placeholderHashes: ReadonlySet<string> | null = null;
function placeholders(): ReadonlySet<string> {
  placeholderHashes ??= new Set(
    bakedTemplates
      .filter((t) => t.blueprint)
      .flatMap((t) => t.assets.filter((a) => SLOTS.some((s) => s === a.slot)).map((a) => a.sha1)),
  );
  return placeholderHashes;
}

/**
 * The logo and icon hashes of every stored version of the blueprint a template was made from: the
 * blueprint's art may have changed since, and the template keeps the copy it was made with.
 */
export async function sourceArtHashes(
  db: D1Database,
  templateId: string,
): Promise<ReadonlySet<string>> {
  return artHashesOf(await sourceBlueprintAssets(db, templateId));
}

/** `sourceArtHashes` for stored asset lists already read (a build reads them with its other inputs). */
export function artHashesOf(storedLists: readonly string[]): ReadonlySet<string> {
  const hashes = new Set<string>();
  for (const stored of storedLists) {
    const assets = z
      .array(z.object({ slot: z.string(), sha1: z.string() }))
      .catch([])
      .parse(JSON.parse(stored));
    for (const a of assets) if (SLOTS.some((s) => s === a.slot)) hashes.add(a.sha1);
  }
  return hashes;
}

/** Test hook: replace the blueprint file hashes; null restores the generated set. */
export function setPlaceholderHashes(hashes: ReadonlySet<string> | null): void {
  placeholderHashes = hashes;
}

/** Logo and icon slots that still hold a blueprint's file; a blueprint's own passes always do. */
export function placeholderSlots(
  templateId: string,
  assets: readonly { slot: string; sha1: string }[],
  sourceHashes: ReadonlySet<string>,
): string[] {
  if (templateId.startsWith('baked:starter-')) return [...SLOTS];
  const hashes = placeholders();
  return SLOTS.filter((slot) =>
    assets.some((a) => a.slot === slot && (hashes.has(a.sha1) || sourceHashes.has(a.sha1))),
  );
}

const slotOfName = (name: string) => name.replace(/(@[23]x)?\.png$/, '');

/**
 * PLATFORM_BRANDING when a tenant pass would ship a blueprint's logo or icon: neither the template,
 * the org branding nor a per-pass override replaces it.
 */
export function brandingWarnings(
  template: { id: string; assets: readonly { slot: string; sha1: string }[] },
  branding: TenantBranding,
  overrideNames: readonly string[],
  sourceHashes: ReadonlySet<string> = new Set(),
): { severity: 'warning'; code: string; message: string; path?: string }[] {
  const replaced = new Set([
    ...branding.images.map((i) => i.slot),
    ...overrideNames.map(slotOfName),
  ]);
  const missing = placeholderSlots(template.id, template.assets, sourceHashes).filter(
    (slot) => !replaced.has(slot),
  );
  if (missing.length === 0) return [];
  return [
    {
      severity: 'warning',
      code: 'PLATFORM_BRANDING',
      message: `Uses the placeholder ${missing.join(' and ')}. Add the organization's ${missing.join(' and ')} in Pass branding.`,
      path: missing[0],
    },
  ];
}
