import type { StyleTag } from './constants.ts';

/** A slot's size in points; pixels are points times the scale (@2x, @3x). */
export interface ImageRule {
  /** [min, max]; min === max is an exact size. Below min warns, above max is an error. */
  width: readonly [number, number];
  height: readonly [number, number];
  /** Older exact sizes Wallet still draws: a warning instead of an error. */
  legacy?: readonly (readonly [number, number])[];
  /** Allowed width / height range. */
  ratio?: readonly [number, number];
}

/**
 * The one image-slot table (Apple HIG, June 2026). The engine validator, the template package
 * analyzer and the per-pass override API all read it.
 */
export const IMAGE_RULES: Readonly<Record<string, ImageRule>> = {
  logo: { width: [50, 160], height: [0, 50] },
  primaryLogo: { width: [30, 126], height: [0, 30] },
  secondaryLogo: { width: [12, 135], height: [0, 12] },
  icon: { width: [38, 38], height: [38, 38], legacy: [[29, 29]] },
  strip: {
    width: [375, 375],
    height: [144, 144],
    legacy: [
      [375, 123],
      [375, 98],
    ],
  },
  thumbnail: { width: [60, 90], height: [60, 90], ratio: [2 / 3, 3 / 2] },
  background: { width: [343, 343], height: [503, 503], legacy: [[345, 505]] },
  artwork: { width: [358, 358], height: [448, 448] },
  footer: { width: [268, 268], height: [15, 15], legacy: [[286, 15]] },
  personalizationLogo: { width: [0, 150], height: [0, 40] },
};

/** Styles that draw each slot (StyleTag adds poster event tickets and semantic boarding passes). */
export const SLOT_STYLES: Readonly<Record<string, readonly StyleTag[]>> = {
  logo: ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'],
  primaryLogo: ['posterGeneric', 'PET', 'SBP'],
  secondaryLogo: ['PET'],
  strip: ['coupon', 'storeCard', 'eventTicket'],
  thumbnail: ['generic', 'eventTicket'],
  artwork: ['PET', 'posterGeneric'],
  footer: ['boardingPass'],
  venueMap: ['PET'],
};

export type SizeVerdict =
  | { level: 'ok' }
  | { level: 'warning' | 'error'; message: string; expected: string };

const px = (w: number, h: number) => `${w} × ${h} px`;

/** "artwork@2x.png must be 716 × 896 px"; ranges name their largest size. */
export function checkImageSize(
  name: string,
  slot: string,
  scale: 1 | 2 | 3,
  width: number,
  height: number,
): SizeVerdict {
  const rule = IMAGE_RULES[slot];
  if (!rule) return { level: 'ok' };
  const [minW, maxW] = rule.width.map((v) => v * scale) as [number, number];
  const [minH, maxH] = rule.height.map((v) => v * scale) as [number, number];
  const exact = minW === maxW && minH === maxH;
  const expected = exact ? px(maxW, maxH) : `at most ${px(maxW, maxH)}`;
  if (exact && width === maxW && height === maxH) return { level: 'ok' };
  const legacy = rule.legacy?.find(([w, h]) => width === w * scale && height === h * scale);
  if (legacy)
    return {
      level: 'warning',
      message: `${name} is the older ${px(width, height)} size; use ${px(maxW, maxH)}.`,
      expected,
    };
  if (exact || width > maxW || height > maxH || width < 1 || height < 1)
    return { level: 'error', message: `${name} must be ${expected}.`, expected };
  if (rule.ratio && (width / height < rule.ratio[0] || width / height > rule.ratio[1]))
    return {
      level: 'error',
      message: `${name} must be ${expected} with an aspect ratio from 2:3 to 3:2.`,
      expected,
    };
  if (width < minW || height < minH)
    return {
      level: 'warning',
      message: `${name} is smaller than ${px(minW, minH)}; it may look soft or tiny.`,
      expected,
    };
  return { level: 'ok' };
}

/** Slots a pass with these style tags draws; icon always. */
export function slotsForStyles(styles: ReadonlySet<StyleTag>, hasArtwork = false): Set<string> {
  const used = new Set<string>(['icon', 'personalizationLogo']);
  for (const [slot, tags] of Object.entries(SLOT_STYLES))
    if (tags.some((t) => styles.has(t))) used.add(slot);
  if (styles.has('eventTicket') || (styles.has('posterGeneric') && !hasArtwork))
    used.add('background');
  return used;
}
