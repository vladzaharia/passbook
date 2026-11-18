// Art for the first blueprint set (PS-19): strips for Pack and Timed ticket, a footer for the Transit
// ticket, thumbnails for Booking, Pickup, Permit and ID card. Motifs sit at the trailing or bottom edge.
import { box, circle, cov, ellipse, hex, mixRgb, over, rot, seg, smooth } from './math.ts';
import type { Painter } from './png.ts';

const tile = (x: number, y: number, W: number, H: number, s: number) =>
  cov(box(x, y, W / 2, H / 2, W / 2, H / 2, 14), s);

// ---------- Pack: lagoon strip, a fanned row of ticket stubs, the first two punched ----------
export const PACK = { bg: hex('#006874'), label: hex('#B2F0EC') };
export const packStrip: Painter = (x, y, W, H, s) => {
  let c = mixRgb(PACK.bg, hex('#07808E'), smooth(0.4, 1, x / W) * 0.8);
  for (let i = 9; i >= 0; i--) {
    const cx = W * 0.5 + i * 15;
    const [rx, ry] = rot(x, y, cx, H * 0.62, (i - 4.5) * 3.2);
    const stub = box(rx, ry, cx, H * 0.62, 17, 40, 5);
    c = over(c, hex('#004A54'), cov(stub - 1.8, s) * 0.35);
    c = over(c, i < 2 ? hex('#7FDCD6') : PACK.label, cov(stub, s));
    c = over(c, PACK.bg, cov(circle(rx, ry, cx, H * 0.62 - 24, i < 2 ? 5 : 2), s) * 0.9);
  }
  return [...c, 255];
};

// ---------- Timed ticket: moss strip, a gallery arch with a sundial arc of twelve ticks ----------
export const TIMED = { bg: hex('#264624'), label: hex('#C4E27C') };
export const timedStrip: Painter = (x, y, W, H, s) => {
  let c = mixRgb(TIMED.bg, hex('#356033'), smooth(0.45, 1, x / W) * 0.9);
  const cx = W * 0.82;
  const base = H + 6;
  const arch = Math.min(box(x, y, cx, base - 30, 40, 70, 0), circle(x, y, cx, base - 100, 40));
  c = over(c, hex('#1B3419'), cov(arch, s) * 0.8);
  c = over(c, hex('#FFF8E7'), cov(Math.abs(arch + 8) - 1.4, s) * 0.5);
  for (let i = 0; i < 12; i++) {
    const a = Math.PI * (1 + i / 11);
    const px = cx + Math.cos(a) * 26;
    const py = base - 58 + Math.sin(a) * 26;
    const lit = i === 4;
    c = over(c, lit ? TIMED.label : hex('#9DBA66'), cov(circle(x, y, px, py, lit ? 3.4 : 1.9), s));
  }
  c = over(c, TIMED.label, cov(seg(x, y, cx, base - 58, cx + Math.cos(Math.PI * (1 + 4 / 11)) * 22, base - 58 + Math.sin(Math.PI * (1 + 4 / 11)) * 22) - 1.3, s));
  return [...c, 255];
};

// ---------- Transit ticket: a dashed route with three stops and a bow chevron, in signal yellow ----------
export const TRANSIT = { bg: hex('#30353C'), label: hex('#FFD23F') };
export const transitFooter: Painter = (x, y, W, H, s) => {
  const mid = H / 2;
  const stops = [4, W * 0.45, W - 24].map((px) => cov(circle(x, y, px, mid, 2.6), s));
  const dash = x > 10 && x < W - 30 && x % 8 < 4.5 ? cov(Math.abs(y - mid) - 0.8, s) : 0;
  const px = W - 10;
  const chevron = Math.min(seg(x, y, px - 4, mid - 6, px + 3, mid) - 1.4, seg(x, y, px - 4, mid + 6, px + 3, mid) - 1.4);
  return [...TRANSIT.label, Math.round(Math.max(...stops, dash, cov(chevron, s)) * 255)];
};

// ---------- Booking: a tear-off calendar page with one day ringed ----------
export const BOOKING = { bg: hex('#FAE6E4'), fg: hex('#3C1A24'), label: hex('#A83A54') };
export const bookingThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#F6D3D0'), BOOKING.bg, y / H);
  const page = box(x, y, W / 2, H * 0.54, W * 0.34, H * 0.36, 7);
  c = over(c, hex('#E2B4B6'), cov(page - 2, s) * 0.5);
  c = over(c, hex('#FFFFFF'), cov(page, s));
  c = over(c, BOOKING.label, cov(box(x, y, W / 2, H * 0.27, W * 0.34, H * 0.09, 7), s) * cov(y - H * 0.3, s));
  for (const px of [0.38, 0.62]) c = over(c, BOOKING.fg, cov(box(x, y, W * px, H * 0.2, 1.8, 6, 1.8), s));
  for (let r = 0; r < 3; r++)
    for (let k = 0; k < 4; k++) {
      const [dx, dy] = [W * (0.3 + k * 0.133), H * (0.5 + r * 0.14)];
      const ringed = r === 1 && k === 2;
      c = over(c, ringed ? BOOKING.label : hex('#C9A0A8'), cov(circle(x, y, dx, dy, ringed ? 2.6 : 1.8), s));
      if (ringed) c = over(c, BOOKING.label, cov(Math.abs(circle(x, y, dx, dy, 8)) - 1.3, s));
    }
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Pickup: a folded paper bag with a round tick seal ----------
export const PICKUP = { bg: hex('#CEF2E2'), fg: hex('#0C3426'), label: hex('#0A6A46') };
export const pickupThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#B5E6D0'), PICKUP.bg, y / H);
  const bag = box(x, y, W / 2, H * 0.58, W * 0.3, H * 0.33, 5);
  c = over(c, hex('#8CC9AE'), cov(bag - 2, s) * 0.5);
  c = over(c, hex('#F3E3C4'), cov(bag, s));
  c = over(c, hex('#E4CFA5'), cov(box(x, y, W / 2, H * 0.3, W * 0.3, H * 0.04, 0), s) * cov(bag, s));
  c = over(c, PICKUP.fg, cov(Math.abs(seg(x, y, W * 0.4, H * 0.3, W * 0.42, H * 0.18)) - 1.4, s));
  c = over(c, PICKUP.fg, cov(Math.abs(seg(x, y, W * 0.6, H * 0.3, W * 0.58, H * 0.18)) - 1.4, s));
  c = over(c, PICKUP.label, cov(circle(x, y, W * 0.5, H * 0.62, W * 0.15), s));
  const tick = Math.min(seg(x, y, W * 0.43, H * 0.62, W * 0.48, H * 0.67), seg(x, y, W * 0.48, H * 0.67, W * 0.58, H * 0.56)) - 1.8;
  c = over(c, hex('#FFFFFF'), cov(tick, s));
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Permit: two bay lines and a windscreen disc ----------
export const PERMIT = { bg: hex('#AA1C2C'), label: hex('#FFD2D4') };
export const permitThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#C0283A'), PERMIT.bg, y / H);
  c = over(c, hex('#8A1220'), cov(box(x, y, W / 2, H * 0.8, W * 0.46, H * 0.2, 0), s) * 0.6);
  for (const px of [0.18, 0.82]) c = over(c, PERMIT.label, cov(box(x, y, W * px, H * 0.74, 2.2, H * 0.24, 0), s));
  c = over(c, hex('#FFFFFF'), cov(circle(x, y, W / 2, H * 0.36, W * 0.22), s));
  c = over(c, PERMIT.bg, cov(Math.abs(circle(x, y, W / 2, H * 0.36, W * 0.15)) - 1.5, s));
  c = over(c, PERMIT.bg, cov(seg(x, y, W / 2, H * 0.36, W / 2 + W * 0.1, H * 0.28) - 1.6, s));
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- ID card: a person silhouette over a 1D barcode, with a red rule ----------
export const ID = { bg: hex('#F4F4F0'), fg: hex('#141416'), label: hex('#C41E3A') };
export const idThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#E6E6E0'), ID.bg, y / H);
  const ink = hex('#2A2A30');
  c = over(c, ink, cov(circle(x, y, W / 2, H * 0.27, W * 0.14), s));
  c = over(c, ink, cov(ellipse(x, y, W / 2, H * 0.58, W * 0.27, H * 0.17), s) * cov(H * 0.42 - y, s));
  const bit = Math.floor((x - W * 0.12) / 2.4);
  const bar = (bit * 7 + (bit % 3) * 5) % 11 < 6 ? 1 : 0;
  c = over(c, ink, cov(box(x, y, W / 2, H * 0.82, W * 0.38, H * 0.08, 0), s) * bar);
  c = over(c, ID.label, cov(Math.abs(y - H * 0.7) - 1.2, s) * cov(Math.abs(x - W / 2) - W * 0.4, s));
  c = over(c, ID.label, cov(y - 3, s));
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};
