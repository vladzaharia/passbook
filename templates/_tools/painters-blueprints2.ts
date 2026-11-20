// Art for the second blueprint set (PS-20): a poster scene for the Multi-day pass, thumbnails for the Hotel
// stay, Credential, Staff badge and Visitor pass. Motifs sit at the trailing or bottom edge.
import { box, circle, clamp, cov, ellipse, hex, mixRgb, over, rot, seg, smooth } from './math.ts';
import type { Painter, Rgb } from './png.ts';

const tile = (x: number, y: number, W: number, H: number, s: number) =>
  cov(box(x, y, W / 2, H / 2, W / 2, H / 2, 14), s);

// ---------- Multi-day: a dark red night, a low coral sun and three woven wristbands ----------
export const MULTI = { bg: hex('#C4342C'), fg: hex('#FFF4EC'), label: hex('#FFD6C4') };
function multiScene(x: number, y: number, W: number, H: number, s: number, bands: boolean): Rgb {
  const v = y / H;
  let c = mixRgb(hex('#2C0C0A'), hex('#7E1C18'), smooth(0.1, 0.55, v));
  c = mixRgb(c, hex('#F06254'), smooth(0.5, 0.82, v));
  const sun = circle(x, y, W * 0.5, H * 0.8, W * 0.26);
  c = over(c, hex('#FFB27A'), clamp(1 - (sun + W * 0.2) / (W * 0.4)) ** 2 * 0.5);
  c = over(c, hex('#FFE0A8'), cov(sun, s));
  if (bands)
    for (let i = 0; i < 3; i++) {
      const cx = W * (0.3 + i * 0.2);
      const [rx, ry] = rot(x, y, cx, H * 0.62, -16 + i * 16);
      const band = box(rx, ry, cx, H * 0.62, W * 0.06, H * 0.17, 5);
      c = over(c, hex('#1A0605'), cov(band, s));
      const weave = Math.floor((ry + 400) / 7) % 2 === 0;
      c = over(c, i === 1 ? hex('#FFD6C4') : hex('#F06254'), cov(band + 3, s) * (weave ? 0.55 : 0.2));
      c = over(c, hex('#FFE0A8'), cov(circle(rx, ry, cx, H * 0.62 - H * 0.12, 3), s));
    }
  c = over(c, hex('#1A0605'), cov(-(y - H * (0.93 + 0.012 * Math.sin((x / W) * 31))), s));
  return c;
}
export const multiArt: Painter = (x, y, W, H, s) => [...multiScene(x, y, W, H, s, true), 255];
export const multiBackground: Painter = (x, y, W, H, s) => [...multiScene(x, y, W, H, s, false), 255];
export const multiThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#2C0C0A'), hex('#C4342C'), (y / H) ** 1.1);
  c = over(c, hex('#FFE0A8'), cov(circle(x, y, W / 2, H * 0.86, W * 0.24), s));
  for (let i = 0; i < 3; i++) {
    const cx = W * (0.3 + i * 0.2);
    const [rx, ry] = rot(x, y, cx, H * 0.5, -16 + i * 16);
    const band = box(rx, ry, cx, H * 0.5, W * 0.06, H * 0.26, 3);
    c = over(c, hex('#1A0605'), cov(band, s));
    c = over(c, i === 1 ? hex('#FFD6C4') : hex('#F06254'), cov(band + 1.6, s) * (Math.floor((ry + 200) / 4) % 2 === 0 ? 0.55 : 0.2));
  }
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Hotel: night plum, an arched window with a moon and a lamp ----------
export const HOTEL = { bg: hex('#3A2040'), fg: hex('#FAF3E6'), label: hex('#EEC478') };
export const hotelThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#4D2B55'), HOTEL.bg, y / H);
  const cx = W / 2;
  const win = Math.min(box(x, y, cx, H * 0.62, W * 0.27, H * 0.3, 0), circle(x, y, cx, H * 0.34, W * 0.27));
  c = over(c, hex('#241230'), cov(win, s));
  c = over(c, HOTEL.label, cov(Math.abs(win) - 1.4, s));
  c = over(c, hex('#FAF3E6'), cov(circle(x, y, W * 0.6, H * 0.3, 7), s));
  c = over(c, hex('#241230'), cov(circle(x, y, W * 0.64, H * 0.28, 6), s));
  c = over(c, HOTEL.label, cov(box(x, y, cx, H * 0.58, 1, H * 0.34, 0), s) * 0.8);
  c = over(c, hex('#6B4A2A'), cov(box(x, y, W * 0.38, H * 0.78, 6, 4, 1.5), s));
  c = over(c, HOTEL.label, cov(circle(x, y, W * 0.38, H * 0.7, 6), s) * 0.9);
  c = over(c, HOTEL.label, cov(circle(x, y, W * 0.38, H * 0.7, 14), s) * 0.18);
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Credential: leather, a rosette seal with two ribbons ----------
export const CREDENTIAL = { bg: hex('#5C3A20'), fg: hex('#FAF0DE'), label: hex('#EAC48C') };
export const credentialThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#70472A'), CREDENTIAL.bg, y / H);
  const gold = CREDENTIAL.label;
  for (const [sign, a] of [[-1, 14], [1, -14]] as const) {
    const [rx, ry] = rot(x, y, W / 2 + sign * W * 0.1, H * 0.74, a);
    c = over(c, hex('#B3323A'), cov(box(rx, ry, W / 2 + sign * W * 0.1, H * 0.74, W * 0.08, H * 0.2, 1), s));
  }
  const cx = W / 2;
  const cy = H * 0.42;
  const wave = Math.atan2(y - cy, x - cx) * 12;
  const rosette = Math.hypot(x - cx, y - cy) - (W * 0.3 + Math.cos(wave) * 2.2);
  c = over(c, hex('#9C7A45'), cov(rosette - 1.6, s) * 0.5);
  c = over(c, gold, cov(rosette, s));
  c = over(c, CREDENTIAL.bg, cov(Math.abs(circle(x, y, cx, cy, W * 0.2)) - 1.2, s) * 0.85);
  const tick = Math.min(seg(x, y, W * 0.4, H * 0.43, W * 0.47, H * 0.5), seg(x, y, W * 0.47, H * 0.5, W * 0.6, H * 0.35)) - 1.8;
  c = over(c, CREDENTIAL.bg, cov(tick, s));
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Staff badge: steel, a badge with a lanyard slot and a teal rule ----------
export const STAFF = { bg: hex('#E2E8EE'), fg: hex('#14181C'), label: hex('#00766C') };
export const staffThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#D2DAE2'), STAFF.bg, y / H);
  const ink = hex('#2A323A');
  c = over(c, ink, cov(seg(x, y, W * 0.5, 0, W * 0.5, H * 0.16) - 2.2, s));
  const badge = box(x, y, W / 2, H * 0.58, W * 0.27, H * 0.38, 8);
  c = over(c, hex('#9AA6B2'), cov(badge - 2, s) * 0.5);
  c = over(c, hex('#FFFFFF'), cov(badge, s));
  c = over(c, ink, cov(box(x, y, W / 2, H * 0.28, W * 0.09, 2.6, 2.6), s));
  c = over(c, STAFF.label, cov(box(x, y, W / 2, H * 0.34, W * 0.27, H * 0.06, 0), s) * cov(badge, s));
  c = over(c, ink, cov(circle(x, y, W / 2, H * 0.52, W * 0.09), s));
  c = over(c, ink, cov(ellipse(x, y, W / 2, H * 0.78, W * 0.17, H * 0.1), s) * cov(H * 0.67 - y, s));
  c = over(c, STAFF.label, cov(y - 3, s));
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};

// ---------- Visitor: the one yellow tile, a clock face on a badge ----------
export const VISITOR = { bg: hex('#FACC15'), fg: hex('#281A08'), label: hex('#6E4800') };
export const visitorThumb: Painter = (x, y, W, H, s) => {
  let c = mixRgb(hex('#FDD93A'), VISITOR.bg, y / H);
  const badge = box(x, y, W / 2, H * 0.55, W * 0.3, H * 0.36, 9);
  c = over(c, hex('#B88A00'), cov(badge - 2, s) * 0.45);
  c = over(c, hex('#FFF8DC'), cov(badge, s));
  c = over(c, VISITOR.fg, cov(box(x, y, W / 2, H * 0.24, W * 0.1, 2.4, 2.4), s));
  const cx = W / 2;
  const cy = H * 0.56;
  c = over(c, VISITOR.fg, cov(Math.abs(circle(x, y, cx, cy, W * 0.2)) - 1.8, s));
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    c = over(c, VISITOR.fg, cov(circle(x, y, cx + Math.sin(a) * W * 0.16, cy - Math.cos(a) * W * 0.16, i % 3 === 0 ? 1.5 : 0.9), s));
  }
  c = over(c, VISITOR.fg, cov(seg(x, y, cx, cy, cx, cy - W * 0.13) - 1.3, s));
  c = over(c, VISITOR.label, cov(seg(x, y, cx, cy, cx + W * 0.09, cy + W * 0.04) - 1.3, s));
  c = over(c, VISITOR.fg, cov(y - 3, s) * 0);
  return [...c, Math.round(tile(x, y, W, H, s) * 255)];
};
