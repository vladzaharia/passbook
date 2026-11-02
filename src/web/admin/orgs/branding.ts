import { contrast, parseColor } from '@/shared/pass-view/color.ts';

export const HEX = /^#[0-9a-fA-F]{6}$/;

/** "#0f172a" or pass.json's "rgb(15, 23, 42)" as "#0f172a" (the colour picker takes hex only). */
export function hexOf(color: string): string | undefined {
  if (HEX.test(color)) return color;
  const m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(color);
  if (!m) return undefined;
  return `#${m
    .slice(1)
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Light and dark email grounds (email shell). */
const EMAIL_LIGHT = '#ffffff';
const EMAIL_DARK = '#060912';

const ratio = (a: string, b: string) => {
  const x = parseColor(a);
  const y = parseColor(b);
  return x && y ? contrast(x, y) : undefined;
};
const fmt = (n: number) => `${n.toFixed(1)}:1`;

/** One sentence per pass colour pair under Apple's minimum (4.5 text, 3 labels). */
export function passColorWarnings(c: {
  background: string;
  foreground: string;
  label: string;
}): string[] {
  if (![c.background, c.foreground, c.label].every((v) => HEX.test(v))) return [];
  const out: string[] = [];
  const text = ratio(c.foreground, c.background);
  if (text !== undefined && text < 4.5)
    out.push(`Text on the background is ${fmt(text)}; Apple asks for 4.5:1.`);
  const label = ratio(c.label, c.background);
  if (label !== undefined && label < 3)
    out.push(`Labels on the background are ${fmt(label)}; Apple asks for 3:1.`);
  return out;
}

/**
 * The accent is link text on the white email ground and the header bar behind white or near-black
 * text. Warn when links fall under 4.5:1 on white, or when neither header text colour reaches it.
 */
export function accentWarnings(accent: string): string[] {
  if (!HEX.test(accent)) return [];
  const light = ratio(accent, EMAIL_LIGHT) ?? 21;
  const dark = ratio(accent, EMAIL_DARK) ?? 21;
  const out: string[] = [];
  if (light < 4.5) out.push(`Links in emails are ${fmt(light)} on white; aim for 4.5:1.`);
  if (Math.max(light, dark) < 4.5) out.push('No header text colour reaches 4.5:1 on this accent.');
  return out;
}

/** Pixel rules at @3x (passkit IMAGE_RULES): icon 38 or 29 pt square, logo up to 160 x 50 pt. */
export function imageSizeError(slot: 'logo' | 'icon', w: number, h: number): string | undefined {
  if (slot === 'icon') {
    return (w === 114 && h === 114) || (w === 87 && h === 87)
      ? undefined
      : `The icon is ${w}x${h}px; use 114x114px or 87x87px.`;
  }
  return w <= 480 && h <= 150 ? undefined : `The logo is ${w}x${h}px; use at most 480x150px.`;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** PNG pixel size from the IHDR chunk; undefined when the file is not a PNG. */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

/** The @2x from the @3x, two thirds in each side; undefined where the browser cannot draw. */
async function derive2x(file: Blob, w: number, h: number): Promise<Uint8Array | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    return undefined;
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(Math.round((w * 2) / 3), Math.round((h * 2) / 3));
  const g = canvas.getContext('2d');
  if (!g) return undefined;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

export interface PreparedImage {
  x3: string;
  x2?: string;
}

/** A file the browser can tell is wrong before upload; the message is one sentence. */
export class ImageInputError extends Error {}

/** Reads an @3x PNG, checks its size and derives the @2x. Throws ImageInputError on failure. */
export async function prepareImage(slot: 'logo' | 'icon', file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = pngSize(bytes);
  if (!size) throw new ImageInputError('Choose a PNG file.');
  const bad = imageSizeError(slot, size.w, size.h);
  if (bad) throw new ImageInputError(bad);
  // A browser that cannot draw the PNG sends the @3x alone; the server derives the @2x.
  const x2 = await derive2x(file, size.w, size.h).catch(() => undefined);
  return { x3: toBase64(bytes), ...(x2 ? { x2: toBase64(x2) } : {}) };
}
