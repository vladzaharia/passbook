import type { StyleTag } from './constants.ts';
import type { ValidationContext } from './util.ts';

export interface ValidatableAsset {
  name: string;
  width?: number;
  height?: number;
}

export interface ParsedImage {
  name: string;
  slot: string;
  scale: 1 | 2 | 3;
  locale?: string;
  width?: number;
  height?: number;
}

type SizeRule =
  | { kind: 'exact'; sizes: [number, number][] }
  | { kind: 'max'; width: number; height: number }
  | { kind: 'thumbnail' };

/** Point sizes; pixels are points times the scale. Alternatives cover the documented contradictions. */
export const IMAGE_RULES: Record<string, SizeRule | undefined> = {
  icon: {
    kind: 'exact',
    sizes: [
      [38, 38],
      [29, 29],
    ],
  },
  logo: { kind: 'max', width: 160, height: 50 },
  primaryLogo: { kind: 'max', width: 126, height: 30 },
  secondaryLogo: { kind: 'max', width: 135, height: 12 },
  strip: {
    kind: 'exact',
    sizes: [
      [375, 144],
      [375, 123],
      [375, 98],
    ],
  },
  thumbnail: { kind: 'thumbnail' },
  artwork: { kind: 'exact', sizes: [[358, 448]] },
  background: {
    kind: 'exact',
    sizes: [
      [345, 505],
      [343, 503],
    ],
  },
  footer: { kind: 'max', width: 286, height: 15 },
  personalizationLogo: { kind: 'max', width: 150, height: 40 },
};

const IMAGE_SLOTS = [...Object.keys(IMAGE_RULES), 'venueMap'];
const IMAGE_NAME = /^(?:([A-Za-z0-9_-]+)\.lproj\/)?([A-Za-z0-9]+)(?:@([23])x)?\.png$/;
const LOCALE_DIR = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const OTHER_FILES =
  /^(?:[A-Za-z0-9_-]+\.lproj\/pass\.strings|personalization\.json|tooling\.json)$/;

const SLOT_STYLES: Record<string, StyleTag[]> = {
  logo: ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'],
  primaryLogo: ['posterGeneric', 'PET', 'SBP'],
  secondaryLogo: ['PET'],
  strip: ['coupon', 'storeCard', 'eventTicket'],
  thumbnail: ['generic', 'eventTicket'],
  artwork: ['PET', 'posterGeneric'],
  footer: ['boardingPass'],
  venueMap: ['PET'],
};

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

function checkSize(ctx: ValidationContext, image: ParsedImage, rule: SizeRule): void {
  const { width, height, scale, slot, name } = image;
  if (width === undefined || height === undefined) return;
  const report = (expected: string) =>
    ctx.error(
      'IMAGE_SIZE',
      `${name} is ${width}x${height}px; ${slot} should be ${expected}.`,
      name,
    );
  if (rule.kind === 'exact') {
    if (!rule.sizes.some(([w, h]) => width === w * scale && height === h * scale))
      report(rule.sizes.map(([w, h]) => `${w * scale}x${h * scale}px`).join(' or '));
  } else if (rule.kind === 'max') {
    if (width > rule.width * scale || height > rule.height * scale)
      report(`at most ${rule.width * scale}x${rule.height * scale}px`);
  } else {
    const ratio = width / height;
    if (width > 90 * scale || height > 90 * scale || ratio < 2 / 3 || ratio > 3 / 2)
      report(`at most ${90 * scale}x${90 * scale}px with an aspect ratio from 2:3 to 3:2`);
  }
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

  for (const image of images) {
    const rule = IMAGE_RULES[image.slot];
    if (rule) checkSize(ctx, image, rule);
  }
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
