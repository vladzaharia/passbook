import type { StyleTag } from './constants.ts';
import { checkImageSize, IMAGE_RULES, SLOT_STYLES } from './image-rules.ts';
import type { ValidationContext } from './util.ts';

export interface ValidatableAsset {
  name: string;
  width?: number;
  height?: number;
  /** Bytes, when known: IMAGE_BYTES and PASS_SIZE use it. */
  size?: number;
}

export interface ParsedImage {
  name: string;
  slot: string;
  scale: 1 | 2 | 3;
  locale?: string;
  width?: number;
  height?: number;
}

export { IMAGE_RULES } from './image-rules.ts';

const IMAGE_SLOTS = [...Object.keys(IMAGE_RULES), 'venueMap'];
const IMAGE_NAME = /^(?:([A-Za-z0-9_-]+)\.lproj\/)?([A-Za-z0-9]+)(?:@([23])x)?\.png$/;
const LOCALE_DIR = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const OTHER_FILES =
  /^(?:[A-Za-z0-9_-]+\.lproj\/pass\.strings|personalization\.json|tooling\.json)$/;

export function parseImageName(name: string): ParsedImage | undefined {
  const m = IMAGE_NAME.exec(name);
  if (!m?.[2]) return undefined;
  return {
    name,
    slot: m[2],
    scale: m[3] ? (Number(m[3]) as 2 | 3) : 1,
    ...(m[1] ? { locale: m[1] } : {}),
  };
}

function checkSize(ctx: ValidationContext, image: ParsedImage): void {
  const { width, height, scale, slot, name } = image;
  if (width === undefined || height === undefined) return;
  const verdict = checkImageSize(name, slot, scale, width, height);
  if (verdict.level === 'error') ctx.error('IMAGE_SIZE', verdict.message, name);
  else if (verdict.level === 'warning') ctx.warn('IMAGE_SIZE', verdict.message, name);
}

function slotUsed(
  slot: string,
  styles: ReadonlySet<StyleTag>,
  has: (s: string) => boolean,
): boolean {
  if (slot === 'background')
    return styles.has('eventTicket') || (styles.has('posterGeneric') && !has('artwork'));
  const used = SLOT_STYLES[slot];
  return !used || used.some((s) => styles.has(s));
}

function signature(images: ParsedImage[]): string {
  return images
    .map((i) => i.scale)
    .sort()
    .join(',');
}

export function parseImages(assets: ValidatableAsset[]): ParsedImage[] {
  const out: ParsedImage[] = [];
  for (const asset of assets) {
    const parsed = parseImageName(asset.name);
    if (parsed && IMAGE_SLOTS.includes(parsed.slot))
      out.push({
        ...parsed,
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
      });
  }
  return out;
}

/** Required slots, per-slot pixel sizes, unused slots and localized image consistency. */
export function validateImages(ctx: ValidationContext, assets: ValidatableAsset[]): ParsedImage[] {
  const { error, warn } = ctx;
  const images = parseImages(assets);
  const known = new Set(images.map((i) => i.name));
  for (const asset of assets) {
    if (known.has(asset.name) || OTHER_FILES.test(asset.name)) continue;
    const parsed = parseImageName(asset.name);
    if (parsed) warn('UNKNOWN_IMAGE', `${parsed.slot} is not a pass image.`, asset.name);
    else warn('ASSET_NAME', 'Unexpected file in the pass package.', asset.name);
  }

  const topLevel = images.filter((i) => !i.locale);
  const has = (slot: string) => images.some((i) => i.slot === slot);
  if (!has('icon')) error('MISSING_ICON', 'icon.png is required.');
  if (ctx.styles.has('PET') && !has('artwork') && !has('background'))
    error('MISSING_IMAGE', 'Poster event tickets need artwork.png or background.png.');
  if (ctx.styles.has('posterGeneric') && !has('artwork') && !has('background'))
    warn('MISSING_IMAGE', 'Poster generic passes need artwork.png.');

  for (const image of images) checkSize(ctx, image);
  const unused = new Set<string>();
  for (const image of images) {
    if (slotUsed(image.slot, ctx.styles, has) || unused.has(image.slot)) continue;
    unused.add(image.slot);
    warn('UNUSED_IMAGE', `No style on this pass uses ${image.slot}.`, image.name);
  }
  if (
    ctx.styles.has('eventTicket') &&
    !ctx.styles.has('PET') &&
    has('strip') &&
    (has('background') || has('thumbnail'))
  )
    warn(
      'IMAGE_CONFLICT',
      'On legacy event tickets strip conflicts with background and thumbnail.',
    );

  // Localized images: each locale must ship the same resolutions, and a top-level image wins.
  const bySlot = new Map<string, Map<string, ParsedImage[]>>();
  for (const image of images) {
    if (!image.locale) continue;
    const locales = bySlot.get(image.slot) ?? new Map<string, ParsedImage[]>();
    locales.set(image.locale, [...(locales.get(image.locale) ?? []), image]);
    bySlot.set(image.slot, locales);
  }
  const allLocales = new Set(
    assets.flatMap((a) => {
      const locale = /^([A-Za-z0-9_-]+)\.lproj\//.exec(a.name)?.[1];
      return locale ? [locale] : [];
    }),
  );
  for (const locale of allLocales)
    if (!LOCALE_DIR.test(locale))
      warn('LOCALE_NAME', `${locale}.lproj is not a language code.`, `${locale}.lproj`);
  for (const [slot, locales] of bySlot) {
    const signatures = new Set([...locales.values()].map(signature));
    if (signatures.size > 1)
      error('LOCALIZED_IMAGES', `Locales ship different resolutions of ${slot}.`, slot);
    const missing = [...allLocales].filter((l) => !locales.has(l));
    if (missing.length)
      warn('LOCALIZED_IMAGES', `${slot} is not localized for ${missing.join(', ')}.`, slot);
    if (topLevel.some((i) => i.slot === slot))
      warn('LOCALIZED_IMAGES', `A top-level ${slot} overrides the localized ones.`, slot);
  }
  return images;
}
