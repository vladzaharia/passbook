// Writes the placeholder artwork of the starter templates. Deterministic: same output on every run.
// Usage: node templates/_tools/generate-art.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

type Pixel = [number, number, number, number];
type Painter = (u: number, v: number, w: number, h: number) => Pixel;

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

/** Per row: the cheapest of None, Sub and Up filters. */
function filterRows(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 4;
  const out = new Uint8Array((stride + 1) * h);
  const score = (row: Uint8Array) => row.reduce((n, b) => n + Math.min(b, 256 - b), 0);
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const sub = new Uint8Array(stride);
    const up = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      sub[i] = (row[i] as number) - (i >= 4 ? (row[i - 4] as number) : 0);
      up[i] = (row[i] as number) - (y > 0 ? (rgba[(y - 1) * stride + i] as number) : 0);
    }
    const options: [number, Uint8Array][] = [
      [0, row],
      [1, sub],
      [2, up],
    ];
    const [type, data] = options.reduce((best, o) => (score(o[1]) < score(best[1]) ? o : best));
    out[y * (stride + 1)] = type;
    out.set(data, y * (stride + 1) + 1);
  }
  return out;
}

function png(w: number, h: number, paint: Painter): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = paint((x + 0.5) / w, (y + 0.5) / h, w, h);
      rgba.set(px, (y * w + x) * 4);
    }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filterRows(rgba, w, h), { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** Distance from p to segment ab, all in pixels. */
function segment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const W_POINTS: [number, number][] = [
  [0.12, 0.22],
  [0.32, 0.78],
  [0.5, 0.38],
  [0.68, 0.78],
  [0.88, 0.22],
];

/** Coverage (0..1) of a W glyph in a square box of `size` px whose top-left is (ox, oy). */
function glyph(x: number, y: number, ox: number, oy: number, size: number, weight: number): number {
  let d = Number.POSITIVE_INFINITY;
  for (let i = 0; i < W_POINTS.length - 1; i++) {
    const a = W_POINTS[i] as [number, number];
    const b = W_POINTS[i + 1] as [number, number];
    d = Math.min(d, segment(x, y, ox + a[0] * size, oy + a[1] * size, ox + b[0] * size, oy + b[1] * size));
  }
  const half = (weight * size) / 2;
  return 1 - smooth(half - 0.75, half + 0.75, d);
}

const INK: [number, number, number] = [31, 41, 55];
const ACCENT: [number, number, number] = [79, 70, 229];

/** Opaque gradient with a faint grid and a W watermark. */
const backdrop: Painter = (u, v, w, h) => {
  const t = (u * 0.35 + v * 0.65) ** 1.1;
  let r = mix(INK[0], ACCENT[0], t);
  let g = mix(INK[1], ACCENT[1], t);
  let b = mix(INK[2], ACCENT[2], t);
  const cell = Math.max(24, Math.min(w, h) / 6);
  const line = Math.min((u * w) % cell, (v * h) % cell);
  const grid = 1 - smooth(0, 1.2, line);
  const size = Math.min(w, h) * 0.5;
  const mark = glyph(u * w, v * h, (w - size) / 2, (h - size) / 2, size, 0.1);
  const lift = Math.max(grid * 0.06, mark * 0.16);
  r = mix(r, 255, lift);
  g = mix(g, 255, lift);
  b = mix(b, 255, lift);
  return [r, g, b, 255];
};

/** Opaque dark tile with a white W, for the icon. */
const icon: Painter = (u, v, w, h) => {
  const size = Math.min(w, h) * 0.78;
  const c = glyph(u * w, v * h, (w - size) / 2, (h - size) / 2, size, 0.15);
  const t = (u + v) / 2;
  return [mix(mix(INK[0], ACCENT[0], t), 255, c), mix(mix(INK[1], ACCENT[1], t), 255, c), mix(mix(INK[2], ACCENT[2], t), 255, c), 255];
};

/** Transparent canvas with a white W, for logos. */
const logo: Painter = (u, v, w, h) => {
  const size = h * 0.9;
  const c = glyph(u * w, v * h, (w - size) / 2, h * 0.05, size, 0.14);
  return [255, 255, 255, Math.round(c * 255)];
};

const SCALES = [1, 2, 3] as const;

interface Slot {
  file: string;
  w: number;
  h: number;
  paint: Painter;
}

/** Point sizes per slot (catalog section 12). */
const SLOTS: Record<string, Slot> = {
  icon: { file: 'icon', w: 38, h: 38, paint: icon },
  logo: { file: 'logo', w: 160, h: 50, paint: logo },
  primaryLogo: { file: 'primaryLogo', w: 126, h: 30, paint: logo },
  secondaryLogo: { file: 'secondaryLogo', w: 135, h: 12, paint: logo },
  thumbnail: { file: 'thumbnail', w: 90, h: 90, paint: backdrop },
  strip: { file: 'strip', w: 375, h: 144, paint: backdrop },
  stripEvent: { file: 'strip', w: 375, h: 98, paint: backdrop },
  artwork: { file: 'artwork', w: 358, h: 448, paint: backdrop },
  footer: { file: 'footer', w: 286, h: 15, paint: backdrop },
};

const STARTERS: Record<string, string[]> = {
  'starter-generic': ['icon', 'logo', 'thumbnail'],
  'starter-poster-generic': ['icon', 'logo', 'primaryLogo', 'artwork'],
  'starter-store-card': ['icon', 'logo', 'strip'],
  'starter-coupon': ['icon', 'logo', 'strip'],
  'starter-event-ticket': ['icon', 'logo', 'primaryLogo', 'secondaryLogo', 'artwork', 'stripEvent'],
  'starter-boarding-pass': ['icon', 'logo', 'primaryLogo', 'footer'],
};

for (const [slug, slots] of Object.entries(STARTERS)) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of slots) {
    const slot = SLOTS[name] as Slot;
    for (const scale of SCALES) {
      const suffix = scale === 1 ? '' : `@${scale}x`;
      const bytes = png(slot.w * scale, slot.h * scale, slot.paint);
      writeFileSync(join(dir, `${slot.file}${suffix}.png`), bytes);
    }
  }
}
