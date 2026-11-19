import type { z } from 'zod';
import type { PassJson } from '@/passkit/types.ts';
import type { MyPassSchema } from '@/shared/contracts/me.ts';
import { normalize, type PassView } from '@/shared/pass-view/index.ts';
import { assetUrlMap } from '../pass-card/assets.ts';

export type MyPass = z.infer<typeof MyPassSchema>;

/** `names` is the server's list of the pass's image files, when it sends one. */
export function assetUrls(base: string | null, names?: readonly string[]): Record<string, string> {
  return base === null ? {} : assetUrlMap(base, names);
}

export function toView(pass: MyPass): PassView {
  return normalize(pass.passJson as unknown as PassJson, {
    assets: assetUrls(pass.assetBaseUrl, pass.assetNames),
  });
}

export function passName(pass: MyPass): string {
  return pass.title ?? pass.templateName;
}

/** What the holder's page can do with the pass: add it, or say why not. */
export type HolderState = 'active' | 'voided' | 'expired' | 'removed';

export function holderState(pass: MyPass, view: PassView): HolderState {
  if (pass.removedAt !== null) return 'removed';
  return pass.status === 'voided' || view.voided ? 'voided' : view.expired ? 'expired' : 'active';
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The pass is titled with the signed-in holder's own name (or the name their email spells). */
export function isHolderName(
  title: string | null,
  user: { name: string | null; primaryEmail: string | null } | undefined,
): boolean {
  if (!title || !user) return false;
  const t = words(title);
  return t === words(user.name ?? '') || t === words((user.primaryEmail ?? '').split('@')[0] ?? '');
}
