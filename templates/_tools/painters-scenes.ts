// Blueprint art for the full-bleed poster and event artwork.
import { PALETTE, FOIL_TEAL, FOIL_VIOLET, FOIL_GOLD, WHITE, box, circle, cov, ellipse, foil, hash, hex, mixRgb, over, clamp, rot, seg, smooth } from './math.ts';
import type { Painter, Rgb } from './png.ts';

// ---------- Poster: violet dusk, gold sun, stars; top and bottom stay dark for text ----------
export const posterArt: Painter = (x, y, W, H, s) => {
  const v = y / H;
  const u = x / W;
  let c = mixRgb(hex('#12052C'), PALETTE.violet.bg, smooth(0.02, 0.32, v));
  c = mixRgb(c, FOIL_VIOLET, smooth(0.3, 0.6, v) * 0.85);
  c = mixRgb(c, hex('#F49AC1'), smooth(0.5, 0.7, v) * 0.8);
  // Stars in the upper sky.
  const gx = Math.floor(x / 14);
  const gy = Math.floor(y / 14);
  const sx = gx * 14 + 3 + hash(gx, gy) * 8;
  const sy = gy * 14 + 3 + hash(gy, gx + 7) * 8;
  if (hash(gx + 3, gy + 5) > 0.72)
    c = over(c, WHITE, cov(circle(x, y, sx, sy, 0.45 + hash(gx, gy + 1) * 0.6), s) * (1 - smooth(0.15, 0.45, v)) * 0.9);
  // Sun with a glow.
  const sun = circle(x, y, W * 0.66, H * 0.6, 36);
  c = over(c, FOIL_GOLD, clamp(1 - (sun + 36) / 120) ** 2 * 0.45);
  c = over(c, hex('#FFE7A8'), cov(sun, s));
  const hill = (k: number, a: number, f: number, p: number) => y - H * (k + a * Math.sin(u * f + p));
  c = over(c, hex('#7C3AED'), cov(-hill(0.66, 0.035, 5, 1.2), s) * 0.85);
  c = over(c, hex('#4C1D95'), cov(-hill(0.74, 0.045, 7, 4), s));
  c = over(c, hex('#24094F'), cov(-hill(0.84, 0.03, 11, 2), s));
  c = over(c, hex('#12052C'), smooth(0.86, 1, v));
  return [...c, 255];
};

// ---------- Event: berry night, gold beams onto a stage, crowd at the bottom ----------
export function eventScene(x: number, y: number, W: number, H: number, s: number, beams: boolean): Rgb {
  const v = y / H;
  const u = x / W;
  let c = mixRgb(hex('#1F0211'), PALETTE.berry.bg, smooth(0.0, 0.45, v));
  c = mixRgb(c, hex('#B0195F'), smooth(0.45, 0.85, v) * 0.85);
  // Stage glow.
  const glow = clamp(1 - Math.hypot((u - 0.5) * 1.6, (v - 0.86) * 3.2));
  c = over(c, hex('#FF7AB0'), glow ** 1.6 * 0.55);
  if (beams)
    for (const [ox, tx, a] of [
      [0.08, 0.42, 0.34],
      [0.5, 0.5, 0.26],
      [0.92, 0.58, 0.34],
    ] as const) {
      // A beam from (ox, 0) widening toward (tx, 0.86).
      const t = clamp(v / 0.86);
      const cx = ox + (tx - ox) * t;
      const half = 0.012 + 0.07 * t;
      const d = (Math.abs(u - cx) - half) * W;
      // Stepped in 48ths: smooth diagonal edges do not compress and the pass would pass 400 KB.
      const k = cov(d / 6, s / 6) * a * (0.35 + 0.65 * t) * (1 - smooth(0.82, 0.9, v));
      c = over(c, FOIL_GOLD, Math.round(k * 48) / 48);
    }
  // Bokeh.
  const gx = Math.floor(x / 26);
  const gy = Math.floor(y / 26);
  if (hash(gx + 11, gy + 2) > 0.8 && v < 0.7) {
    const bx = gx * 26 + 6 + hash(gx, gy) * 14;
    const by = gy * 26 + 6 + hash(gy, gx) * 14;
    c = over(c, hex('#FFD3E6'), cov(circle(x, y, bx, by, 2 + hash(gx, gy + 9) * 3), s) * 0.18);
  }
  // Crowd: a row of heads and shoulders.
  const row = y - H * (0.9 + 0.025 * Math.sin(u * 47) + 0.012 * Math.sin(u * 113 + 1));
  c = over(c, hex('#1F0211'), cov(-row, s));
  return c;
}
export const eventArt: Painter = (x, y, W, H, s) => [...eventScene(x, y, W, H, s, true), 255];
export const eventBackground: Painter = (x, y, W, H, s) => [...eventScene(x, y, W, H, s, false), 255];
export const eventThumb: Painter = (x, y, W, H, s) => {
  const tile = cov(box(x, y, W / 2, H / 2, W / 2, H / 2, 14), s);
  let c = mixRgb(hex('#1F0211'), hex('#B0195F'), (y / H) ** 1.2);
  const t = clamp(y / (H * 0.7));
  const d = (Math.abs(x / W - 0.5) - (0.03 + 0.16 * t)) * W;
  c = over(c, FOIL_GOLD, cov(d, s) * 0.32 * (1 - smooth(0.65, 0.75, y / H)));
  c = over(c, hex('#FFE7A8'), cov(ellipse(x, y, W / 2, H * 0.74, W * 0.24, H * 0.07), s));
  return [...c, Math.round(tile * 255)];
};

