import { forgetArt, forgetPatches, renderStrip, type StampArt } from './compose.ts';
import { encodePng, type Rgba } from './png.ts';

export interface StampStrip {
  /** Stamps on the card this strip draws. */
  count: number;
  scale: 2 | 3;
  /** Name inside a template version: `stamps/strips/7/strip@2x.png`. */
  name: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export const stampStripName = (count: number, scale: 2 | 3): string =>
  `stamps/strips/${count}/strip@${scale}x.png`;

export interface StampStripsRequest {
  goal: number;
  art: StampArt;
  /** The template's own strip per scale; missing means transparent. */
  base: Partial<Record<2 | 3, Rgba>>;
  tilt?: boolean;
  /** Counts to draw; default every count 0 to goal. */
  counts?: readonly number[];
}

/** One PNG pair per count. Pure and deterministic, so a version can store the result. */
export function stampStrips(req: StampStripsRequest): StampStrip[] {
  const counts = req.counts ?? Array.from({ length: req.goal + 1 }, (_, i) => i);
  const scales = [2, 3] as const;
  const out: StampStrip[] = new Array(counts.length * scales.length);
  try {
    // Scale by scale: a scale's resampled patches are shared by every count, then dropped.
    scales.forEach((scale, si) => {
      counts.forEach((count, ci) => {
        const image = renderStrip({
          goal: req.goal,
          count,
          scale,
          base: req.base[scale] ?? 'transparent',
          art: req.art,
          ...(req.tilt === false ? { tilt: false } : {}),
        });
        out[ci * scales.length + si] = {
          count,
          scale,
          name: stampStripName(count, scale),
          width: image.width,
          height: image.height,
          bytes: encodePng(image),
        };
      });
      forgetPatches(req.art);
    });
  } finally {
    forgetArt(req.art);
  }
  return out;
}
