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
): string {
  const from = `/p/${passToken}/assets/`;
  return path.startsWith(from)
    ? `/b/${bundleToken}/${passId}/assets/${path.slice(from.length)}`
    : path;
}

export const bundleImages = (
  images: readonly PassImage[],
  passToken: string,
  bundleToken: string,
  passId: string,
): PassImage[] =>
  images.map((i) => ({ ...i, path: bundleAssetPath(i.path, passToken, bundleToken, passId) }));
