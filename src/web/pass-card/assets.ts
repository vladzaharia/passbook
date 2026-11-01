import { IMAGE_SLOTS } from '../../shared/pass-view/images.ts';

const SCALES = ['', '@2x', '@3x'] as const;

/** Every top-level image name a pass can use; the guess when the server sends no list. */
export const CANDIDATE_ASSETS: readonly string[] = IMAGE_SLOTS.flatMap((slot) =>
  SCALES.map((scale) => `${slot}${scale}.png`),
);

/** The API returns absolute URLs; a path also works on http dev origins, which safeImageUrl rejects. */
function sameOriginPath(url: string): string {
  // Also compiled for the Worker (SSR), which has no DOM types and no location.
  const origin = (globalThis as { location?: { origin: string } }).location?.origin;
  return origin && url.startsWith(`${origin}/`) ? url.slice(origin.length) : url;
}

/**
 * Asset file name to served URL. Pass the names the server has; without them every candidate
 * is mapped and the card hides images that fail to load.
 */
export function assetUrlMap(base: string, names?: readonly string[]): Record<string, string> {
  const root = sameOriginPath(base).replace(/\/+$/, '');
  const out: Record<string, string> = {};
  for (const name of names ?? CANDIDATE_ASSETS) out[name] = `${root}/${encodeURIComponent(name)}`;
  return out;
}
