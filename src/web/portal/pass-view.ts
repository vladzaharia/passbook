import type { z } from 'zod';
import type { PassJson } from '@/passkit/types.ts';
import type { MyPassSchema } from '@/shared/contracts/me.ts';
import { normalize, type PassView } from '@/shared/pass-view/index.ts';
import { assetUrlMap } from '../pass-card/assets.ts';

export type MyPass = z.infer<typeof MyPassSchema>;

/** `names` is the server's list of the pass's image files, when it sends one. */
export function assetUrls(base: string, names?: readonly string[]): Record<string, string> {
  return assetUrlMap(base, names);
}

export function toView(pass: MyPass): PassView {
  return normalize(pass.passJson as unknown as PassJson, {
    assets: assetUrls(pass.assetBaseUrl, pass.assetNames),
  });
}

export function passName(pass: MyPass): string {
  return pass.title ?? pass.templateName;
}

export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
