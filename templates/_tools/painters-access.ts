// Access card thumbnail: three nested door arches (teal, violet, gold) opening on a pale threshold.
import { FOIL_GOLD, FOIL_TEAL, FOIL_VIOLET, PALETTE, box, circle, cov, foil, hex, mixRgb, over } from './math.ts';
import type { Painter } from './png.ts';

/** Signed distance to an arch: a box with a semicircular top, `r` wide, standing on `base`. */
function arch(x: number, y: number, cx: number, base: number, r: number, h: number): number {
  const top = base - h + r;
  const body = box(x, y, cx, (base + top) / 2, r, (base - top) / 2, 0);
  return Math.min(body, circle(x, y, cx, top, r));
}

export const accessThumb: Painter = (x, y, W, H, s) => {
  const tile = cov(box(x, y, W / 2, H / 2, W / 2, H / 2, 14), s);
  let c = mixRgb(PALETTE.cobalt.bg, hex('#142A8C'), (x / W) * 0.3 + (y / H) * 0.7);
  c = over(c, hex('#4F6BE8'), cov(circle(x, y, W * 0.3, H * 0.15, W * 0.5), s) * 0.28);
  const base = H * 0.84;
  const rings: [number, number, readonly number[]][] = [
    [W * 0.36, H * 0.66, FOIL_TEAL],
    [W * 0.25, H * 0.5, FOIL_VIOLET],
    [W * 0.14, H * 0.34, FOIL_GOLD],
  ];
  for (const [r, h, ink] of rings) {
    const d = Math.abs(arch(x, y, W / 2, base, r, h)) - 1.6;
    // The ring stays open at the threshold so the doors read as opening.
    c = over(c, ink as [number, number, number], cov(d, s) * cov(y - base, s));
  }
  c = over(c, hex('#CFE0FF'), cov(Math.abs(y - base) - 1.2, s) * cov(Math.abs(x - W / 2) - W * 0.4, s));
  c = over(c, foil(x / W), cov(y - 3, s));
  return [...c, Math.round(tile * 255)];
};
