/**
 * Google art from template art only (architecture 2.4, owner answer Q18): a `wallets/google/`
 * override wins, else the Apple slot. A personal file is never sent. A file below Google's minimum
 * is not upscaled: the slot is left empty and reported.
 */

import { sizeReason } from '../art-size.ts';
import type { CapabilityId, Support, ViewImageFile } from '../types.ts';
import type { Ctx } from './ctx.ts';
import { TEXT } from './limits.ts';
import type { GoogleImage } from './types.ts';

const APPLE_CAPABILITY: Record<string, CapabilityId> = {
  logo: 'image.logo',
  icon: 'image.icon',
  strip: 'image.strip',
  background: 'image.background',
  thumbnail: 'image.thumbnail',
  artwork: 'image.artwork',
};
const OVERRIDE_CAPABILITY = {
  logo: 'image.logo',
  hero: 'image.strip',
  thumbnail: 'image.thumbnail',
} as const;

export interface PickSpec {
  /** The `wallets.google.images` slot that overrides this one. */
  override?: keyof typeof OVERRIDE_CAPABILITY;
  /** Apple slots to try, in order. */
  apple: readonly string[];
  min: { width?: number; height?: number };
  /** What an empty slot means. A generic logo falls back to the first letter of the title. */
  loss: Extract<Support, 'omitted' | 'difference'>;
  /** Said after the reason an image could not be carried. */
  fallback?: string;
  /** An optional extra: nothing is reported when it cannot be carried. */
  quiet?: boolean;
}

interface Candidate {
  capability: CapabilityId;
  slot: string;
  files: readonly ViewImageFile[];
}

function problem(file: ViewImageFile, slot: string, min: PickSpec['min']): string | undefined {
  if (!file.url) return sizeReason('google', slot, file) ?? `${file.name} has no public URL.`;
  if (min.width !== undefined && file.width !== undefined && file.width < min.width)
    return `${file.name} is ${file.width} px wide; Google needs ${min.width}.`;
  if (min.height !== undefined && file.height !== undefined && file.height < min.height)
    return `${file.name} is ${file.height} px high; Google needs ${min.height}.`;
  return undefined;
}

export function pickImage(ctx: Ctx, spec: PickSpec): GoogleImage | undefined {
  const { images } = ctx.view;
  const override = spec.override ? images.overrides.google?.[spec.override] : undefined;
  const candidates: Candidate[] =
    spec.override && override
      ? [{ capability: OVERRIDE_CAPABILITY[spec.override], slot: spec.override, files: [override] }]
      : spec.apple.flatMap((slot) => {
          const files = images.apple[slot] ?? [];
          const capability = APPLE_CAPABILITY[slot];
          return files.length > 0 && capability ? [{ capability, slot, files }] : [];
        });

  const failures: { capability: CapabilityId; path: string; message: string }[] = [];
  for (const { capability, slot, files } of candidates) {
    const path = `images.${slot}`;
    if (!spec.quiet && ctx.left(capability, path)) return undefined;
    if (files.some((f) => f.personal))
      ctx.note('image.personal', path, 'omitted', 'Personal images are never sent to Google.');
    if (files.some((f) => f.locale !== undefined))
      ctx.note(
        'localization.images',
        path,
        'difference',
        'Localized images use the default image.',
      );
    const best = files.find((f) => !f.personal && f.locale === undefined);
    if (!best) continue;
    const message = problem(best, slot, spec.min);
    if (message) {
      failures.push({ capability, path, message });
      continue;
    }
    return {
      sourceUri: { uri: best.url as string },
      contentDescription: ctx.localized(path, ctx.view.org, TEXT.title),
    };
  }
  if (!spec.quiet)
    for (const f of failures)
      ctx.note(
        f.capability,
        f.path,
        spec.loss,
        spec.fallback ? `${f.message} ${spec.fallback}` : f.message,
      );
  return undefined;
}
