import type { TemplateManifest, ValidationIssue } from '../types.ts';

/** The parts of the organization's brand a template may keep its own of. */
export const BRAND_PARTS = ['colors', 'logo', 'icon'] as const;
export type BrandPartName = (typeof BRAND_PARTS)[number];

/**
 * The optional `brand` block of `wallet.template.json`: `{ colors?, logo?, icon? }`, each `org`
 * (default: the organization's value wins where it has one) or `template` (this template keeps its
 * own, whatever the organization sets). A template without the block builds as it always did.
 */
export function brandManifestIssues(manifest: TemplateManifest): ValidationIssue[] {
  const raw: unknown = manifest.brand;
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return [
      {
        severity: 'error',
        code: 'BRAND_SHAPE',
        message: 'brand must be an object of part: "org" | "template".',
        path: 'brand',
      },
    ];
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(BRAND_PARTS as readonly string[]).includes(key))
      issues.push({
        severity: 'error',
        code: 'BRAND_UNKNOWN',
        message: `Unknown brand part "${key}".`,
        path: `brand/${key}`,
      });
    else if (value !== 'org' && value !== 'template')
      issues.push({
        severity: 'error',
        code: 'BRAND_SOURCE',
        message: `brand.${key} must be "org" or "template".`,
        path: `brand/${key}`,
      });
  }
  return issues;
}

/** The parts this template keeps its own of. */
export function ownBrandParts(
  manifest: Pick<TemplateManifest, 'brand'> | null | undefined,
): BrandPartName[] {
  const brand = manifest?.brand;
  return brand ? BRAND_PARTS.filter((p) => brand[p] === 'template') : [];
}
