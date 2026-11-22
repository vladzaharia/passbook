import { contrast, mix, type Rgb } from '@/shared/pass-view/color.ts';

export interface Palette {
  id: 'dark' | 'bold' | 'light';
  background: string;
  foreground: string;
  label: string;
  /** The three colours as the chip draws them. */
  swatches: [string, string, string];
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const hex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
const sat = ({ r, g, b }: Rgb) => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};
const lum = ({ r, g, b }: Rgb) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const dist = (a: Rgb, b: Rgb) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/** Moves `c` toward white or black, whichever reads better on `bg`, until it clears `min`. */
function ensure(c: Rgb, bg: Rgb, min: number): Rgb {
  const toward = contrast(WHITE, bg) >= contrast(BLACK, bg) ? WHITE : BLACK;
  let out = c;
  for (let t = 0; t <= 1.001 && contrast(out, bg) < min; t += 0.1) out = mix(c, toward, t);
  return out;
}

/** The dominant opaque colours of an image, most common first, with near twins merged. */
export function dominantColors(data: ArrayLike<number>, limit = 4): Rgb[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 200) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n += 1;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .map((x) => ({ r: Math.round(x.r / x.n), g: Math.round(x.g / x.n), b: Math.round(x.b / x.n) }));
  const out: Rgb[] = [];
  for (const c of ranked) {
    if (out.every((o) => dist(o, c) > 60)) out.push(c);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * Three pass palettes from a logo's colours: Dark (ink on the logo's darkest colour), Bold (the
 * logo's strongest colour as the ground) and Light. Every text and label pair clears Apple's
 * 4.5:1 and 3:1, so a chip never offers a warning.
 */
export function paletteFromPixels(data: ArrayLike<number>): Palette[] {
  const colors = dominantColors(data);
  if (colors.length === 0) return [];
  const accent =
    [...colors].sort(
      (a, b) => sat(b) * (1 - Math.abs(lum(b) - 0.55)) - sat(a) * (1 - Math.abs(lum(a) - 0.55)),
    )[0] ??
    colors[0] ??
    BLACK;
  const ink = [...colors].sort((a, b) => lum(a) - lum(b))[0] ?? BLACK;
  const build = (id: Palette['id'], bg: Rgb, fg: Rgb, label: Rgb): Palette => {
    const text = ensure(fg, bg, 4.5);
    const lab = ensure(label, bg, 3);
    return {
      id,
      background: hex(bg),
      foreground: hex(text),
      label: hex(lab),
      swatches: [hex(bg), hex(text), hex(lab)],
    };
  };
  const deep = lum(ink) < 0.3 ? ink : mix(ink, BLACK, 0.55);
  const pale = mix(accent, WHITE, 0.92);
  return [
    build('dark', deep, WHITE, accent),
    build('bold', accent, WHITE, ink),
    build('light', pale, mix(ink, BLACK, 0.4), accent),
  ];
}

/** Reads a PNG's pixels at a small size; undefined where the browser cannot draw. */
export async function paletteOf(file: Blob): Promise<Palette[]> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return [];
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  const g = canvas.getContext('2d');
  if (!g) return [];
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return paletteFromPixels(g.getImageData(0, 0, canvas.width, canvas.height).data);
}

const LIGHT_PAGE: Rgb = { r: 0xf6, g: 0xf8, b: 0xff };
const DARK_PAGE: Rgb = { r: 0x06, g: 0x09, b: 0x12 };
const MID: Rgb = { r: 128, g: 128, b: 140 };

/** The pass colours with text and labels nudged to Apple's 4.5:1 and 3:1; the background stays. */
export function fixPassColors(bg: string, fg: string, label: string) {
  const b = parseHex(bg);
  const f = parseHex(fg);
  const l = parseHex(label);
  if (!b || !f || !l) return { foreground: fg, label };
  return { foreground: hex(ensure(f, b, 4.5)), label: hex(ensure(l, b, 3)) };
}

/** An accent moved toward a mid grey until it reads at 3:1 on both the light and the dark page. */
export function fixAccent(accent: string): string {
  const a = parseHex(accent);
  if (!a) return accent;
  let out = a;
  for (let t = 0; t <= 1.001; t += 0.1) {
    out = mix(a, MID, t);
    if (contrast(out, LIGHT_PAGE) >= 3 && contrast(out, DARK_PAGE) >= 3) break;
  }
  return hex(out);
}

function parseHex(value: string): Rgb | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return m
    ? {
        r: Number.parseInt(m[1] ?? '0', 16),
        g: Number.parseInt(m[2] ?? '0', 16),
        b: Number.parseInt(m[3] ?? '0', 16),
      }
    : undefined;
}
