// The placeholder org mark, as the white logo and the icon on the identity colour.
import { box, cov, over } from './math.ts';
import type { Painter, Rgb } from './png.ts';
import { WHITE } from './math.ts';

// ---------- the placeholder org mark (unchanged geometry) ----------
export function mark(x: number, y: number, size: number, s: number): { shape: number; cut: number } {
  const c = size / 2;
  const shape = cov(box(x, y, c, c, c, c, size * 0.24), s);
  const bar1 = cov(box(x, y, size * 0.42, size * 0.36, size * 0.2, size * 0.075, size * 0.075), s);
  const bar2 = cov(box(x, y, size * 0.56, size * 0.62, size * 0.2, size * 0.075, size * 0.075), s);
  return { shape, cut: Math.max(bar1, bar2) };
}
export const logo =
  (ink: Rgb): Painter =>
  (x, y, W, H, s) => {
    const { shape, cut } = mark(x, y, Math.min(W, H), s);
    return [...ink, Math.round(shape * (1 - cut * 0.85) * 255)];
  };
export const icon =
  (bg: Rgb, ink: Rgb = WHITE): Painter =>
  (x, y, W, H, s) => {
    const size = Math.min(W, H) * 0.7;
    const off = (Math.min(W, H) - size) / 2;
    const { shape, cut } = mark(x - off, y - off, size, s);
    return [...over(bg, ink, shape * (1 - cut)), 255];
  };

