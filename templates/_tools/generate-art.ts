// Writes the placeholder artwork of the starter templates. Deterministic: same output on every run.
// Usage: node templates/_tools/generate-art.ts
// Each starter gets its own picture; logos are trimmed marks, thumbnails are rounded on
// transparent, motifs sit at the trailing or bottom edge (HIG, June 2026). @2x and @3x only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Rgb = [number, number, number];
type Pixel = [number, number, number, number];
/** u, v in 0..1 across the image; s = pixels per point. */
type Painter = (u: number, v: number, w: number, h: number, s: number) => Pixel;

const root = join(import.meta.dirname, '..');

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Up filter per row: smooth art compresses best with it. */
function filterRows(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 4;
  const out = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    out[y * (stride + 1)] = 2;
    for (let i = 0; i < stride; i++)
      out[y * (stride + 1) + 1 + i] =
        (rgba[y * stride + i] as number) - (y > 0 ? (rgba[(y - 1) * stride + i] as number) : 0);
  }
  return out;
}
function png(w: number, h: number, s: number, paint: Painter): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) rgba.set(paint((x + 0.5) / w, (y + 0.5) / h, w, h, s), (y * w + x) * 4);
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, w);
  new DataView(header.buffer).setUint32(4, h);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filterRows(rgba, w, h), { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * clamp(t));
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
/** Antialiased coverage of a signed distance (negative inside), in pixels. */
const cover = (d: number) => clamp(0.5 - d);
/** Signed distance to a rounded box centred at (cx, cy) with half size (hx, hy). */
function box(x: number, y: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function seg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const over = (base: Rgb, top: Rgb, a: number): Rgb => mixRgb(base, top, a);

/** The placeholder org mark: a rounded square with two offset bars. Fills its square box. */
function mark(x: number, y: number, size: number): { shape: number; cut: number } {
  const c = size / 2;
  const shape = cover(box(x, y, c, c, c, c, size * 0.24));
  const bar1 = cover(box(x, y, size * 0.42, size * 0.36, size * 0.2, size * 0.075, size * 0.075));
  const bar2 = cover(box(x, y, size * 0.56, size * 0.62, size * 0.2, size * 0.075, size * 0.075));
  return { shape, cut: Math.max(bar1, bar2) };
}
/** White mark on transparent, trimmed: the image is exactly the mark. */
const logo: Painter = (u, v, w, h) => {
  const { shape, cut } = mark(u * w, v * h, Math.min(w, h));
  return [255, 255, 255, Math.round(shape * (1 - cut * 0.85) * 255)];
};
/** Opaque icon: the mark on its own colour. */
const icon =
  (bg: Rgb): Painter =>
  (u, v, w, h) => {
    const size = Math.min(w, h) * 0.7;
    const off = (Math.min(w, h) - size) / 2;
    const { shape, cut } = mark(u * w - off, v * h - off, size);
    return [...over(bg, [255, 255, 255], shape * (1 - cut)), 255];
  };

const INK: Rgb = [31, 41, 55];
const SLATE: Rgb = [71, 85, 105];
const WARM: Rgb = [234, 88, 12];
const SUN: Rgb = [251, 191, 36];
const TEAL: Rgb = [15, 118, 110];
const NIGHT: Rgb = [30, 27, 75];
const MAGENTA: Rgb = [190, 24, 93];

/** Generic: neutral person tile, rounded on transparent. */
const genericThumb: Painter = (u, v, w, h, s) => {
  const r = cover(box(u * w, v * h, w / 2, h / 2, w / 2, h / 2, 12 * s));
  let c = mixRgb(SLATE, INK, v);
  c = over(c, [203, 213, 225], cover(Math.hypot(u * w - w / 2, v * h - h * 0.4) - w * 0.17));
  c = over(c, [203, 213, 225], cover(box(u * w, v * h, w / 2, h * 0.9, w * 0.3, h * 0.22, w * 0.2)));
  return [...c, Math.round(r * 255)];
};

/** Coupon: warm strip, perforated bottom edge, a big ticket stub at the trailing edge. */
const couponStrip: Painter = (u, v, w, h, s) => {
  let c = mixRgb(WARM, SUN, u * 0.8 + v * 0.2);
  const stub = box(u * w, v * h, w * 0.86, h * 0.48, w * 0.1, h * 0.3, 10 * s);
  c = over(c, [255, 247, 237], cover(stub) * 0.9);
  const pct = Math.min(
    seg(u * w, v * h, w * 0.82, h * 0.64, w * 0.9, h * 0.32),
    Math.hypot(u * w - w * 0.815, v * h - h * 0.36) - 5 * s,
    Math.hypot(u * w - w * 0.905, v * h - h * 0.6) - 5 * s,
  );
  c = over(c, WARM, cover(pct - 2.2 * s) * cover(stub));
  const hole = Math.hypot(((u * w) % (14 * s)) - 7 * s, v * h - h) - 4 * s;
  return [...c, Math.round(cover(-hole) * 255)];
};

/** Store card: teal strip with a balance chip at the trailing edge. */
const storeStrip: Painter = (u, v, w, h, s) => {
  let c = mixRgb(TEAL, [17, 94, 89], v * 0.7 + u * 0.3);
  c = over(c, [45, 212, 191], cover(Math.hypot(u * w - w * 1.02, v * h - h * 1.1) - h * 0.9) * 0.25);
  const chip = box(u * w, v * h, w * 0.84, h * 0.62, w * 0.12, h * 0.17, 9 * s);
  c = over(c, [240, 253, 250], cover(chip));
  const bars = Math.min(
    box(u * w, v * h, w * 0.81, h * 0.58, w * 0.06, 2.2 * s, 2 * s),
    box(u * w, v * h, w * 0.79, h * 0.67, w * 0.04, 2.2 * s, 2 * s),
  );
  c = over(c, TEAL, cover(bars));
  return [...c, 255];
};

/** Event poster: night gradient with light beams. */
const eventArt: Painter = (u, v, w, h, s) => {
  let c = mixRgb(NIGHT, MAGENTA, v ** 1.2);
  for (const [x, a] of [
    [0.25, 0.2],
    [0.7, 0.16],
  ] as const) {
    const beam = Math.abs(u - x - (v - 1) * 0.25) - 0.05 * (1 - v);
    c = over(c, [253, 224, 71], cover(beam * w) * a * (1 - v * 0.6));
  }
  return [...c, 255];
};
/** Classic event ticket: the poster colours as a quiet background. */
const eventBackground: Painter = (u, v) => [...mixRgb(NIGHT, MAGENTA, v ** 1.4 * 0.8 + u * 0.1), 255];
/** Classic event ticket thumbnail: the poster colours with a bright disc, rounded on transparent. */
const eventThumb: Painter = (u, v, w, h, s) => {
  const r = cover(box(u * w, v * h, w / 2, h / 2, w / 2, h / 2, 14 * s));
  let c = mixRgb(NIGHT, MAGENTA, v ** 1.2);
  c = over(c, [253, 224, 71], cover(Math.hypot(u * w - w / 2, v * h - h * 0.46) - w * 0.2));
  return [...c, Math.round(r * 255)];
};

/** Boarding footer: a dashed route with a plane at the trailing end. */
const routeFooter: Painter = (u, v, w, h, s) => {
  const y = h / 2;
  const dash = (u * w) % (8 * s) < 5 * s ? cover(Math.abs(v * h - y) - 0.8 * s) : 0;
  const px = w - 8 * s;
  const plane = Math.min(
    seg(u * w, v * h, px - 6 * s, y, px + 6 * s, y) - 1.4 * s,
    seg(u * w, v * h, px - 1 * s, y - 6 * s, px + 2 * s, y + 6 * s) - 1.2 * s,
  );
  const a = u * w < px - 10 * s ? dash : cover(plane);
  return [255, 255, 255, Math.round(a * 230)];
};

/** Poster generic: a dusk landscape; the top stays dark so white header text reads (4.5:1). */
const posterArt: Painter = (u, v, w, h, s) => {
  const sky = clamp((v - 0.12) / 0.7) ** 1.2;
  let c = mixRgb([49, 46, 129], [244, 114, 182], sky);
  c = over(c, [255, 251, 235], cover(Math.hypot(u * w - w * 0.68, v * h - h * 0.38) - 34 * s));
  const hill = (k: number, a: number, f: number) => v - (k + a * Math.sin(u * f + k * 9));
  c = over(c, [126, 34, 206], clamp(hill(0.58, 0.04, 5) * h) * 0.75);
  c = over(c, [76, 29, 149], clamp(hill(0.7, 0.05, 7) * h));
  c = over(c, [30, 27, 75], clamp(hill(0.84, 0.03, 11) * h));
  return [...c, 255];
};

interface Slot {
  file: string;
  w: number;
  h: number;
  paint: Painter;
}
const STARTERS: Record<string, Slot[]> = {
  'starter-generic': [
    { file: 'icon', w: 38, h: 38, paint: icon(INK) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'thumbnail', w: 90, h: 90, paint: genericThumb },
  ],
  'starter-coupon': [
    { file: 'icon', w: 38, h: 38, paint: icon(WARM) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'strip', w: 375, h: 144, paint: couponStrip },
  ],
  'starter-store-card': [
    { file: 'icon', w: 38, h: 38, paint: icon(TEAL) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'strip', w: 375, h: 144, paint: storeStrip },
  ],
  'starter-event-ticket': [
    { file: 'icon', w: 38, h: 38, paint: icon(NIGHT) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo },
    { file: 'secondaryLogo', w: 12, h: 12, paint: logo },
    { file: 'artwork', w: 358, h: 448, paint: eventArt },
    { file: 'background', w: 343, h: 503, paint: eventBackground },
    { file: 'thumbnail', w: 90, h: 90, paint: eventThumb },
  ],
  'starter-boarding-pass': [
    { file: 'icon', w: 38, h: 38, paint: icon(INK) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo },
    { file: 'footer', w: 268, h: 15, paint: routeFooter },
  ],
  'starter-poster-generic': [
    { file: 'icon', w: 38, h: 38, paint: icon(NIGHT) },
    { file: 'logo', w: 50, h: 50, paint: logo },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo },
    { file: 'artwork', w: 358, h: 448, paint: posterArt },
  ],
};

const STALE = ['', '@2x', '@3x'].flatMap((x) =>
  ['icon', 'logo', 'primaryLogo', 'secondaryLogo', 'thumbnail', 'strip', 'artwork', 'background', 'footer'].map(
    (f) => `${f}${x}.png`,
  ),
);
for (const [slug, slots] of Object.entries(STARTERS)) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of STALE) rmSync(join(dir, name), { force: true });
  for (const slot of slots)
    for (const scale of [2, 3])
      writeFileSync(
        join(dir, `${slot.file}@${scale}x.png`),
        png(slot.w * scale, slot.h * scale, scale, slot.paint),
      );
}
