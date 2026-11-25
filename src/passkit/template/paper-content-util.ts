/** The photo rule of the paper content. */
import type { PaperKind } from './paper.ts';
import type { PaperContentInput } from './paper-content.ts';

/** A badge or credential leads with the holder's photo; so does an ID-style card whose door shows one. */
export function wantsPhoto(kind: PaperKind, manifest: PaperContentInput['manifest']): boolean {
  if (kind === 'badge' || kind === 'credential') return true;
  const display = (manifest.scan as { scan?: never; display?: { photo?: unknown } } | undefined)
    ?.display;
  return kind === 'membership' && Boolean(display?.photo);
}
