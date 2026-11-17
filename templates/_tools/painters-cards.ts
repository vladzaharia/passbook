// Blueprint art for the thumbnail, strip and footer slots.
import { PALETTE, FOIL_TEAL, FOIL_VIOLET, FOIL_GOLD, WHITE, box, circle, cov, ellipse, foil, hash, hex, mixRgb, over, clamp, rot, seg, smooth } from './math.ts';
import type { Painter, Rgb } from './png.ts';

// ---------- Generic: PassBook ink, a member tile with a foil top edge ----------
export const genericThumb: Painter = (x, y, W, H, s) => {
  const tile = cov(box(x, y, W / 2, H / 2, W / 2, H / 2, 14), s);
  let c = mixRgb(hex('#2A3452'), PALETTE.ink.bg, (x / W) * 0.4 + (y / H) * 0.6);
  c = over(c, hex('#3B4A75'), cov(circle(x, y, W * 0.15, H * 0.1, W * 0.55), s) * 0.35);
  const person = hex('#DBE4FF');
  c = over(c, person, cov(circle(x, y, W / 2, H * 0.42, W * 0.16), s) * 0.92);
  c = over(c, person, cov(box(x, y, W / 2, H * 0.93, W * 0.3, H * 0.24, W * 0.22), s) * 0.92);
  // Foil edge: a 3 pt band across the top, teal -> violet -> gold.
  const band = cov(y - 3, s);
  c = over(c, foil(x / W), band);
  return [...c, Math.round(tile * 255)];
};


// ---------- Coupon: tangerine strip, a cream tag with a percent at the trailing edge ----------
export const couponStrip: Painter = (x, y, W, H, s) => {
  const u = x / W;
  let c = mixRgb(PALETTE.tangerine.bg, hex('#E0580A'), smooth(0.45, 1, u) * 0.9 + (y / H) * 0.1);
  // Diagonal sheen bands.
  const band = ((x + y * 0.6) % 46) / 46;
  c = over(c, WHITE, (band < 0.5 ? 0.035 : 0) * smooth(0.4, 0.7, u));
  // The tag, rotated.
  const [tx, ty] = rot(x, y, W * 0.8, H * 0.5, -12);
  const tag = Math.max(box(tx, ty, W * 0.8, H * 0.5, 50, 36, 10), -box(tx, ty, W * 0.8 - 50, H * 0.5, 0, 36, 0) - 0);
  const notch = circle(tx, ty, W * 0.8 - 50, H * 0.5, 9);
  const tagD = Math.max(tag, -notch);
  c = over(c, hex('#7A2A00'), cov(tagD - 1.5, s) * 0.25 * cov(-(ty - H * 0.5 - 40), s));
  c = over(c, hex('#FFF4E8'), cov(tagD, s));
  const hole = circle(tx, ty, W * 0.8 - 30, H * 0.5, 4.5);
  c = over(c, mixRgb(PALETTE.tangerine.bg, hex('#E0580A'), 0.7), cov(hole, s));
  // Percent: two rings and a slash.
  const pc = PALETTE.tangerine.bg;
  const r1 = Math.abs(circle(tx, ty, W * 0.8 + 2, H * 0.5 - 13, 7)) - 3;
  const r2 = Math.abs(circle(tx, ty, W * 0.8 + 26, H * 0.5 + 13, 7)) - 3;
  const sl = seg(tx, ty, W * 0.8 + 28, H * 0.5 - 22, W * 0.8, H * 0.5 + 22) - 3.2;
  c = over(c, pc, cov(Math.min(r1, r2, sl), s) * cov(tagD, s));
  // Sparkles.
  for (const [px, py, r] of [
    [0.6, 0.22, 3.2],
    [0.97, 0.18, 2.4],
    [0.63, 0.82, 2.2],
    [0.95, 0.86, 3],
  ] as const) {
    const d = Math.min(
      box(x, y, W * px, H * py, r, 0.6, 0.6),
      box(x, y, W * px, H * py, 0.6, r, 0.6),
    );
    c = over(c, hex('#FFE0C2'), cov(d, s) * 0.9);
  }
  return [...c, 255];
};

// ---------- Boarding: a dashed route with a plane, in the label colour ----------
export const routeFooter: Painter = (x, y, W, H, s) => {
  const col = PALETTE.sky.label;
  const mid = H / 2;
  const startDot = cov(circle(x, y, 4, mid, 2.6), s);
  const dash = x > 10 && x < W - 22 && x % 8 < 4.5 ? cov(Math.abs(y - mid) - 0.8, s) : 0;
  const px = W - 10;
  const plane = Math.min(
    seg(x, y, px - 7, mid, px + 7, mid) - 1.5,
    seg(x, y, px + 1, mid - 6.5, px - 2, mid + 6.5) - 1.3,
    seg(x, y, px - 6, mid - 3, px - 6, mid + 3) - 1.1,
  );
  const a = Math.max(startDot, dash, cov(plane, s));
  return [...col, Math.round(a * 255)];
};

// ---------- Balance: teal strip, gold coins dropping into a stitched pocket ----------
function coin(x: number, y: number, cx: number, cy: number, r: number, tilt: number, s: number, c: Rgb): Rgb {
  const a = r;
  const b = r * tilt;
  const edge = ellipse(x, y, cx, cy + r * 0.16 * (1 - tilt) + 1.6, a, b);
  let out = over(c, hex('#9A6A0E'), cov(edge, s));
  const face = ellipse(x, y, cx, cy, a, b);
  out = over(out, hex('#F2C14E'), cov(face, s));
  out = over(out, hex('#FFE29A'), cov(Math.abs(ellipse(x, y, cx, cy, a * 0.72, b * 0.72)) - 0.9, s) * cov(face, s));
  // Shine: a short diagonal highlight.
  const sh = seg(x, y, cx - a * 0.35, cy - b * 0.1, cx - a * 0.1, cy - b * 0.45) - 1.4;
  out = over(out, WHITE, cov(sh, s) * 0.55 * cov(face, s));
  return out;
}
export const balanceStrip: Painter = (x, y, W, H, s) => {
  const u = x / W;
  let c = mixRgb(PALETTE.teal.bg, hex('#0B6B5C'), smooth(0.35, 1, u));
  c = over(c, FOIL_TEAL, clamp(1 - circle(x, y, W * 0.95, -10, 0) / 170) ** 2 * 0.22);
  // Coins: one mid-air, one above, one dropping into the pocket (drawn before it, so it hides).
  c = coin(x, y, W * 0.84, H * 0.42, 16, 0.7, s, c);
  c = coin(x, y, W * 0.74, H * 0.16, 14, 0.92, s, c);
  c = coin(x, y, W * 0.79, 102, 17, 0.42, s, c);
  // Pocket at the trailing bottom edge: a darker panel with a stitched rim.
  const pocket = box(x, y, W * 0.8, H + 12, 66, 52, 18);
  c = over(c, hex('#003A32'), cov(pocket, s));
  const rim = Math.abs(box(x, y, W * 0.8, H + 12, 60, 46, 14));
  const stitch = (x + y) % 7 < 3.6 ? cov(rim - 0.7, s) : 0;
  c = over(c, FOIL_TEAL, stitch * 0.55 * cov(pocket, s));
  for (const [ax, ay, bx, by] of [
    [0.74, 0.0, 0.74, 0.02],
    [0.7, -0.02, 0.7, 0.0],
    [0.84, 0.18, 0.84, 0.24],
    [0.885, 0.2, 0.885, 0.25],
  ] as const) {
    const d = seg(x, y, W * ax, H * ay, W * bx, H * by) - 1.1;
    c = over(c, hex('#F2D07D'), cov(d, s) * 0.6);
  }
  return [...c, 255];
};

