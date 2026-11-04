import { checkImageSize, IMAGE_RULES } from '@/passkit/schema/image-rules.ts';
import type { DesignDoc, DraftAsset } from './model.ts';

export interface PngInfo {
  width: number;
  height: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width and height from the IHDR chunk, or null when the bytes are not a PNG. */
export function readPng(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export const assetName = (slot: string, scale: 1 | 2 | 3): string =>
  `${slot}${scale === 1 ? '' : `@${scale}x`}.png`;

/** "38 x 38 pt: 114 x 114 px (@3x) or 76 x 76 px (@2x)", or the largest size for ranges. */
export function slotHint(slot: string): string {
  const rule = IMAGE_RULES[slot];
  if (!rule) return 'PNG';
  const [, w] = rule.width;
  const [, h] = rule.height;
  const exact = rule.width[0] === w && rule.height[0] === h;
  if (exact) return `${w} × ${h} pt: ${w * 3} × ${h * 3} px (@3x) or ${w * 2} × ${h * 2} px (@2x)`;
  return `Up to ${w} × ${h} pt: ${w * 3} × ${h * 3} px (@3x)`;
}

export type Placed =
  | { ok: true; asset: DraftAsset; warning?: string }
  | { ok: false; message: string };

/** Reads a dropped file for a slot and picks @3x or @2x by its pixel size. */
export function placeImage(slot: string, bytes: Uint8Array): Placed {
  const png = readPng(bytes);
  if (!png) return { ok: false, message: 'Use a PNG file.' };
  const oks: { scale: 2 | 3; warning?: string }[] = [];
  const warns: { scale: 2 | 3; warning?: string }[] = [];
  for (const scale of [3, 2] as const) {
    const verdict = checkImageSize(assetName(slot, scale), slot, scale, png.width, png.height);
    if (verdict.level === 'ok') oks.push({ scale });
    else if (verdict.level === 'warning') warns.push({ scale, warning: verdict.message });
  }
  const best = oks[0] ?? warns[0];
  if (best) {
    const asset: DraftAsset = {
      name: assetName(slot, best.scale),
      slot,
      scale: best.scale,
      size: bytes.length,
      width: png.width,
      height: png.height,
      upload: toBase64(bytes),
    };
    return best.warning ? { ok: true, asset, warning: best.warning } : { ok: true, asset };
  }
  return {
    ok: false,
    message: `${png.width} × ${png.height} px does not fit. Use ${slotHint(slot)}.`,
  };
}

/** Localized files (`fr.lproj/logo.png`) belong to a slot but are not the slot's own image. */
export const isSlotImage = (a: DraftAsset, slot: string): boolean =>
  a.slot === slot && !a.name.includes('/');

/** Replaces the slot's own files with `asset` (null removes them); localized files stay. */
export function setSlotImage(doc: DesignDoc, slot: string, asset: DraftAsset | null): DesignDoc {
  const rest = doc.assets.filter((a) => !isSlotImage(a, slot));
  return { ...doc, assets: asset ? [...rest, asset] : rest };
}

/** The request body of the versions endpoint. */
export function assetsPayload(assets: readonly DraftAsset[]) {
  return assets.map((a) =>
    a.upload !== undefined
      ? { name: a.name, upload: a.upload }
      : { name: a.name, sha1: a.sha1 ?? '' },
  );
}

/** Preview URLs: new files as data URLs, saved ones from the template's asset route. */
export function previewAssetMap(
  assets: readonly DraftAsset[],
  baseUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of assets) {
    if (!a.name.endsWith('.png')) continue;
    out[a.name] =
      a.upload !== undefined
        ? `data:image/png;base64,${a.upload}`
        : `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(a.name)}`;
  }
  return out;
}
