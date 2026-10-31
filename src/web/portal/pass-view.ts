import type { z } from 'zod';
import type { PassJson } from '@/passkit/types.ts';
import type { MyPassSchema } from '@/shared/contracts/me.ts';
import { normalize, type PassView } from '@/shared/pass-view/index.ts';

export type MyPass = z.infer<typeof MyPassSchema>;

const IMAGES = ['icon', 'logo', 'strip', 'background', 'thumbnail', 'footer'] as const;
const SCALES = ['', '@2x', '@3x'] as const;

/** Maps every image file name a pass may reference to its served URL. */
export function assetUrls(base: string): Record<string, string> {
  const root = base.replace(/\/+$/, '');
  const out: Record<string, string> = {};
  for (const name of IMAGES) {
    for (const scale of SCALES) {
      const file = `${name}${scale}.png`;
      out[file] = `${root}/${file}`;
    }
  }
  return out;
}

export function toView(pass: MyPass): PassView {
  return normalize(pass.passJson as unknown as PassJson, {
    assets: assetUrls(pass.assetBaseUrl),
  });
}

export function passName(pass: MyPass): string {
  return pass.title ?? pass.templateName;
}

export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
