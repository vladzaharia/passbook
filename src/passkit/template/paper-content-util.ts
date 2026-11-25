/** The photo rule of the paper content. */
import type { PaperKind } from './paper.ts';
import type { PaperArt, PaperContentInput } from './paper-content.ts';

/** A badge or credential leads with the holder's photo; so does an ID-style card whose door shows one. */
export function wantsPhoto(kind: PaperKind, manifest: PaperContentInput['manifest']): boolean {
  if (kind === 'badge' || kind === 'credential') return true;
  const display = (manifest.scan as { scan?: never; display?: { photo?: unknown } } | undefined)
    ?.display;
  return kind === 'membership' && Boolean(display?.photo);
}

/** The art slots a class draws in its band, in order of preference. */
export const ART_ORDER: Record<PaperKind, PaperArt[]> = {
  coupon: ['strip', 'artwork', 'background'],
  admission: ['artwork', 'background', 'thumbnail', 'strip'],
  // Never the thumbnail: on an ID card it is the member's photo.
  membership: ['artwork', 'background'],
  permit: [],
  pickup: [],
  journey: ['artwork', 'background', 'strip'],
  booking: ['artwork', 'background'],
  stay: ['artwork', 'background'],
  badge: [],
  credential: [],
};
