import type { PassImage } from '../public/service.ts';

/**
 * A pass's images are served under `/p/:passToken/assets/`. A bundle link serves them under its
 * own token instead, so the pass tokens never reach the page or the email and a revoked bundle
 * takes its images with it.
 */
export function bundleAssetPath(
  path: string,
  passToken: string,
  bundleToken: string,
  passId: string,
): string | null {
  const from = `/p/${passToken}/assets/`;
  // Fail closed: a path outside the pass prefix would carry the pass token into the bundle.
  return path.startsWith(from)
    ? `/b/${bundleToken}/${passId}/assets/${path.slice(from.length)}`
    : null;
}

export const bundleImages = (
  images: readonly PassImage[],
  passToken: string,
  bundleToken: string,
  passId: string,
): PassImage[] =>
  images.flatMap((i) => {
    const path = bundleAssetPath(i.path, passToken, bundleToken, passId);
    return path === null ? [] : [{ ...i, path }];
  });
