// Maths, colour and brand palette for the blueprint art. Distances are in points, negative inside.
import type { Rgb } from './png.ts';

// ---------- maths ----------
export const clamp = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * clamp(t));
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
export const over = (base: Rgb, top: Rgb, a: number): Rgb => mixRgb(base, top, a);
/** Coverage of a distance in points (negative inside), antialiased over one pixel. */
export const cov = (d: number, s: number) => clamp(0.5 - d * s);
export const hex = (h: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
export function box(x: number, y: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
export const circle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;
export function seg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Approximate ellipse distance (fine for the mild tilts used here). */
export function ellipse(x: number, y: number, cx: number, cy: number, a: number, b: number): number {
  return (Math.hypot((x - cx) / a, (y - cy) / b) - 1) * Math.min(a, b);
}
export function rot(x: number, y: number, cx: number, cy: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(r) + dy * Math.sin(r), cy - dx * Math.sin(r) + dy * Math.cos(r)];
}
/** Deterministic hash noise in 0..1. */
export function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------- palette ----------
export const PALETTE = {
  ink: { bg: hex('#141A2B'), fg: hex('#FFFFFF'), label: hex('#5EEAD4') },
  violet: { bg: hex('#361273'), fg: hex('#FFFFFF'), label: hex('#D8C7F9') },
  berry: { bg: hex('#5E0636'), fg: hex('#FFFFFF'), label: hex('#F6C5D6') },
  tangerine: { bg: hex('#B54000'), fg: hex('#FFFFFF'), label: hex('#FFEEDD') },
  sky: { bg: hex('#03528E'), fg: hex('#FFFFFF'), label: hex('#BFE4FB') },
  teal: { bg: hex('#004B41'), fg: hex('#FFFFFF'), label: hex('#F2D07D') },
  cobalt: { bg: hex('#1D3ABA'), fg: hex('#FFFFFF'), label: hex('#CFE0FF') },
  paper: { bg: hex('#FCF4E6'), fg: hex('#311C0F'), label: hex('#A24019') },
} as const;
export const FOIL_TEAL = hex('#2DD4BF');
export const FOIL_VIOLET = hex('#9A5CFF');
export const FOIL_GOLD = hex('#FFC24D');
export const WHITE: Rgb = [255, 255, 255];
/** Teal -> violet at 55% -> gold, the brand foil. */
export function foil(t: number): Rgb {
  return t < 0.55 ? mixRgb(FOIL_TEAL, FOIL_VIOLET, t / 0.55) : mixRgb(FOIL_VIOLET, FOIL_GOLD, (t - 0.55) / 0.45);
}

