import type { BrandPartName } from '@/passkit/template/brand.ts';
import type { DesignDoc, Dict } from './model.ts';
import { isRecord } from './model.ts';

/** The brand parts this draft keeps its own of: the manifest's `brand` block, `template` entries. */
export function ownParts(doc: DesignDoc): BrandPartName[] {
  const brand = doc.manifest.brand;
  if (!isRecord(brand)) return [];
  return (['colors', 'logo', 'icon'] as const).filter((p) => brand[p] === 'template');
}

/**
 * Keep this part for the template (`own`) or follow the organization again. The block holds only
 * `template` entries and goes away when empty, so a template that follows the organization carries
 * no `brand` block at all.
 */
export function setBrandPart(doc: DesignDoc, part: BrandPartName, own: boolean): DesignDoc {
  const parts = ownParts(doc).filter((p) => p !== part);
  if (own) parts.push(part);
  if (parts.length === ownParts(doc).length && parts.every((p) => ownParts(doc).includes(p)))
    return doc;
  const { brand: _old, ...rest } = doc.manifest;
  const manifest: Dict =
    parts.length === 0
      ? rest
      : { ...rest, brand: Object.fromEntries(parts.sort().map((p) => [p, 'template'])) };
  return { ...doc, manifest };
}
