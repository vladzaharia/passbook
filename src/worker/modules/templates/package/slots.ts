import type { ImageSlot, PassJson, PassStyle } from '../../../../passkit/types.ts';
import { PASS_STYLES } from '../../../../passkit/types.ts';

export type SlotName = ImageSlot | 'personalizationLogo';

interface SlotRule {
  w: number;
  h: number;
  /** exact: width and height must equal the size; max: neither may exceed it. */
  mode: 'exact' | 'max' | 'any';
  /** Extra accepted exact sizes (legacy styles), in points. */
  alt?: [number, number][];
}

/** Points; multiply by scale. Source: Apple pass image table (audit A 5.4). */
export const SLOT_RULES: Record<SlotName, SlotRule> = {
  icon: { w: 38, h: 38, mode: 'exact' },
  logo: { w: 160, h: 50, mode: 'max' },
  primaryLogo: { w: 126, h: 30, mode: 'max' },
  secondaryLogo: { w: 135, h: 12, mode: 'max' },
  strip: {
    w: 375,
    h: 144,
    mode: 'exact',
    alt: [
      [375, 123],
      [375, 98],
    ],
  },
  thumbnail: { w: 90, h: 90, mode: 'exact' },
  artwork: { w: 358, h: 448, mode: 'exact' },
  background: { w: 345, h: 505, mode: 'exact' },
  footer: { w: 286, h: 15, mode: 'max' },
  personalizationLogo: { w: 150, h: 40, mode: 'max' },
  venueMap: { w: 0, h: 0, mode: 'any' },
};

export const SLOT_NAMES = Object.keys(SLOT_RULES) as SlotName[];

const POSTER: SlotName[] = ['primaryLogo', 'secondaryLogo', 'artwork'];

const STYLE_SLOTS: Record<PassStyle, SlotName[]> = {
  generic: ['logo', 'thumbnail'],
  posterGeneric: ['logo', ...POSTER],
  storeCard: ['logo', 'strip'],
  coupon: ['logo', 'strip'],
  eventTicket: ['logo', 'strip', 'background', 'thumbnail'],
  boardingPass: ['logo', 'footer'],
};

export function stylesOf(pass: PassJson): PassStyle[] {
  return PASS_STYLES.filter((s) => typeof pass[s] === 'object' && pass[s] !== null);
}

/** Slots the pass can display. icon is always used; poster schemes add the poster slots. */
export function usedSlots(pass: PassJson): Set<SlotName> {
  const used = new Set<SlotName>(['icon', 'personalizationLogo']);
  for (const style of stylesOf(pass)) for (const slot of STYLE_SLOTS[style]) used.add(slot);
  const schemes = Array.isArray(pass.preferredStyleSchemes) ? pass.preferredStyleSchemes : [];
  if (schemes.some((s) => typeof s === 'string' && s.startsWith('poster')))
    for (const slot of POSTER) used.add(slot);
  return used;
}

export function checkSize(
  slot: SlotName,
  scale: 1 | 2 | 3,
  width: number,
  height: number,
): string | null {
  const rule = SLOT_RULES[slot];
  if (rule.mode === 'any') return null;
  if (rule.alt?.some(([aw, ah]) => width === aw * scale && height === ah * scale)) return null;
  const w = rule.w * scale;
  const h = rule.h * scale;
  if (rule.mode === 'exact')
    return width === w && height === h
      ? null
      : `${slot} must be ${w}x${h}, got ${width}x${height}.`;
  return width <= w && height <= h
    ? null
    : `${slot} must be at most ${w}x${h}, got ${width}x${height}.`;
}
