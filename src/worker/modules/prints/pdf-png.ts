/**
 * PNGs for the PDF, through the repo's bounded decoder (passkit/schema/image-pixels.ts, which stops
 * inflating at the size the header allows). pdf-lib's own PNG decoder has no such limit: a small
 * file can inflate to hundreds of MB and kill the isolate. A file is refused when it is animated,
 * interlaced, has a palette depth under 8 bits, or is larger than a paper slot can be; anything
 * larger than the print needs (300 dpi at its size on paper) is shrunk before it is embedded.
 */
import { zlibSync } from 'fflate';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import { decodePixels } from '../../../passkit/schema/image-pixels.ts';

/** An image embedded in the document: the XObject and its pixel size. */
export interface PdfPicture {
  ref: PDFRef;
  width: number;
  height: number;
}

/** The largest paper image slot is 1074 x 1344 (1.44 M pixels). */
export const MAX_IMAGE_PIXELS = 2_000_000;
/** A larger file than this is refused unread. */
export const MAX_IMAGE_BYTES = 2_000_000;
const DPI = 300;

/** How a picture is drawn, for the resolution it needs: the box it fills and whether it covers it. */
export interface PictureFit {
  wMm: number;
  hMm: number;
  /** `cover` scales to fill the box (art); `contain` to fit inside it (a logo). */
  mode: 'cover' | 'contain';
}

interface Pixels {
  width: number;
  height: number;
  rgb: Uint8Array;
  alpha: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** True when the chunk list names an animation (APNG): pdf-lib would decode every frame. */
function animated(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length; ) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'acTL' || type === 'fdAT') return true;
    if (type === 'IEND') return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

/** Averages source blocks into `tw` x `th`, weighting colour by alpha so edges stay clean. */
function shrink(src: Pixels, tw: number, th: number): Pixels {
  const rgb = new Uint8Array(tw * th * 3);
  const alpha = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * src.height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * src.height) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * src.width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * src.width) / tw));
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const p = y * src.width + x;
          const w = src.alpha[p] as number;
          a += w;
          r += (src.rgb[p * 3] as number) * w;
          g += (src.rgb[p * 3 + 1] as number) * w;
          b += (src.rgb[p * 3 + 2] as number) * w;
        }
      const n = (x1 - x0) * (y1 - y0);
      const t = ty * tw + tx;
      alpha[t] = Math.round(a / n);
      const div = a || 1;
      rgb[t * 3] = Math.round(r / div);
      rgb[t * 3 + 1] = Math.round(g / div);
      rgb[t * 3 + 2] = Math.round(b / div);
    }
  }
  return { width: tw, height: th, rgb, alpha };
}

/** The decoded pixels of a PNG, shrunk to what `fit` needs; null when the file is refused. */
export function readPng(bytes: Uint8Array, fit: PictureFit): Pixels | null {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 45) return null;
  if (SIGNATURE.some((v, i) => bytes[i] !== v)) return null;
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The header's size is checked before anything is allocated for it.
  if (head.getUint32(16) * head.getUint32(20) > MAX_IMAGE_PIXELS) return null;
  if (animated(bytes)) return null;
  const pixels = decodePixels(bytes);
  if (!pixels) return null;
  const mmPerPx =
    fit.mode === 'cover'
      ? Math.max(fit.wMm / pixels.width, fit.hMm / pixels.height)
      : Math.min(fit.wMm / pixels.width, fit.hMm / pixels.height);
  const scale = Math.min(1, (mmPerPx * DPI) / 25.4);
  if (scale >= 1) return pixels;
  return shrink(
    pixels,
    Math.max(1, Math.round(pixels.width * scale)),
    Math.max(1, Math.round(pixels.height * scale)),
  );
}

/** Embeds pixels as a Flate RGB image with a soft mask for the alpha, when it has any. */
export function embedPixels(doc: PDFDocument, px: Pixels): PdfPicture {
  const ctx = doc.context;
  const base = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: px.width,
    Height: px.height,
    BitsPerComponent: 8,
    Filter: 'FlateDecode',
  };
  const opaque = px.alpha.every((a) => a === 255);
  const mask = opaque
    ? undefined
    : ctx.register(ctx.stream(zlibSync(px.alpha), { ...base, ColorSpace: 'DeviceGray' }));
  const ref = ctx.register(
    ctx.stream(zlibSync(px.rgb), {
      ...base,
      ColorSpace: 'DeviceRGB',
      ...(mask ? { SMask: mask } : {}),
    }),
  );
  return { ref, width: px.width, height: px.height };
}
