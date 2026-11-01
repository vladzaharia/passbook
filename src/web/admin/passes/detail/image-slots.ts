import { checkImageSize, IMAGE_RULES } from '@/passkit/schema/image-rules.ts';

const STYLE_SLOTS: Record<string, readonly string[]> = {
  posterGeneric: ['artwork', 'primaryLogo'],
  posterEventTicket: ['artwork', 'primaryLogo', 'secondaryLogo'],
  semanticBoardingPass: ['primaryLogo'],
  storeCard: ['strip'],
  coupon: ['strip'],
  eventTicket: ['strip', 'background', 'thumbnail'],
  generic: ['thumbnail'],
  boardingPass: ['footer'],
};
const ORDER = [
  'icon',
  'logo',
  'primaryLogo',
  'secondaryLogo',
  'artwork',
  'strip',
  'background',
  'thumbnail',
  'footer',
];

const slotOf = (name: string) => /^(?:[^/]+\.lproj\/)?([A-Za-z]+)(?:@[23]x)?\.png$/.exec(name)?.[1];

/**
 * The slots this pass's template fills, in display order: the style's slots that the template
 * ships, plus icon and logo. A style slot the template leaves empty is not offered.
 */
export function usedSlots(
  passJson: Record<string, unknown>,
  assetNames: readonly string[],
): string[] {
  const schemes = Array.isArray(passJson.preferredStyleSchemes)
    ? (passJson.preferredStyleSchemes as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];
  const styles = [...schemes, ...Object.keys(STYLE_SLOTS).filter((k) => k in passJson)];
  const drawn = new Set(['icon', 'logo', ...styles.flatMap((s) => STYLE_SLOTS[s] ?? [])]);
  const shipped = new Set(assetNames.map(slotOf).filter(Boolean));
  return ORDER.filter(
    (slot) => drawn.has(slot) && (shipped.has(slot) || slot === 'icon' || slot === 'logo'),
  );
}

const px = (w: number, h: number) => `${w} × ${h} px`;

/** "716 × 896 px" for exact slots, "up to 320 × 100 px" for ranges. */
export function requiredSize(slot: string, scale: 2 | 3): string {
  const rule = IMAGE_RULES[slot];
  if (!rule) return '';
  const [w, h] = [rule.width[1] * scale, rule.height[1] * scale];
  const exact = rule.width[0] === rule.width[1] && rule.height[0] === rule.height[1];
  return exact ? px(w, h) : `up to ${px(w, h)}`;
}

/**
 * The scale a dropped image fits (@2x before @3x), or the error naming the expected sizes. A
 * legacy size still fits; the server warns about it.
 */
export function fitScale(
  slot: string,
  width: number,
  height: number,
): { scale: 2 | 3 } | { error: string } {
  for (const scale of [2, 3] as const) {
    const verdict = checkImageSize(`${slot}@${scale}x.png`, slot, scale, width, height);
    if (verdict.level !== 'error') {
      // A range slot accepts any smaller image at @2x; prefer @3x when it is too big for @2x.
      return { scale };
    }
  }
  return {
    error: `${px(width, height)} does not fit ${slot}. Use ${requiredSize(slot, 2)} (@2x) or ${requiredSize(slot, 3)} (@3x).`,
  };
}

export const SLOT_LABEL: Record<string, string> = {
  icon: 'Icon',
  logo: 'Logo',
  primaryLogo: 'Primary logo',
  secondaryLogo: 'Secondary logo',
  artwork: 'Artwork',
  strip: 'Strip',
  background: 'Background',
  thumbnail: 'Thumbnail',
  footer: 'Footer',
};
