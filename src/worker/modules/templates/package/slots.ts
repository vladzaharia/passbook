import type { StyleTag } from '../../../../passkit/schema/constants.ts';
import { checkImageSize, slotsForStyles } from '../../../../passkit/schema/image-rules.ts';
import type { ImageSlot, PassJson, PassStyle } from '../../../../passkit/types.ts';
import { PASS_STYLES } from '../../../../passkit/types.ts';

export type SlotName = ImageSlot | 'personalizationLogo';

/** Every slot the package may carry; sizes live in the shared IMAGE_RULES table. */
export const SLOT_NAMES: SlotName[] = [
  'icon',
  'logo',
  'primaryLogo',
  'secondaryLogo',
  'strip',
  'thumbnail',
  'artwork',
  'background',
  'footer',
  'personalizationLogo',
  'venueMap',
];

export function stylesOf(pass: PassJson): PassStyle[] {
  return PASS_STYLES.filter((s) => typeof pass[s] === 'object' && pass[s] !== null);
}

/** Style tags of a pass.json: its style dictionaries plus PET and SBP when their scheme is set. */
export function styleTagsOf(pass: PassJson): Set<StyleTag> {
  const tags = new Set<StyleTag>(stylesOf(pass));
  const schemes = Array.isArray(pass.preferredStyleSchemes) ? pass.preferredStyleSchemes : [];
  if (schemes.includes('posterEventTicket') && tags.has('eventTicket')) tags.add('PET');
  if (schemes.includes('semanticBoardingPass') && tags.has('boardingPass')) tags.add('SBP');
  if (schemes.includes('posterGeneric')) tags.add('posterGeneric');
  return tags;
}

/** Slots the pass can display (SLOT_STYLES); icon always, background as the validator decides. */
export function usedSlots(pass: PassJson, hasArtwork = true): Set<SlotName> {
  return slotsForStyles(styleTagsOf(pass), hasArtwork) as Set<SlotName>;
}

/** The IMAGE_RULES verdict for one file, or null when it fits. Legacy sizes come back as warnings. */
export function checkSize(
  name: string,
  slot: SlotName,
  scale: 1 | 2 | 3,
  width: number,
  height: number,
): { level: 'error' | 'warning'; message: string } | null {
  const verdict = checkImageSize(name, slot, scale, width, height);
  return verdict.level === 'ok' ? null : verdict;
}
