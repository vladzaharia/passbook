import { readPng, toBase64 } from './images.ts';
import type { DraftAsset } from './model.ts';
import { ART_HINT } from './stamps.ts';

const MIN = 128;
const MAX = 1000;
const SOFT = 256;

export type PlacedArt =
  | { ok: true; asset: DraftAsset; warning?: string }
  | { ok: false; message: string };

/** A dropped file as stamp art: a square PNG, 128 to 1000 px; under 256 px it is soft. */
export function placeStampArt(file: string, bytes: Uint8Array): PlacedArt {
  const png = readPng(bytes);
  if (!png) return { ok: false, message: 'Use a PNG file.' };
  if (png.width !== png.height || png.width < MIN || png.width > MAX)
    return { ok: false, message: `${png.width} × ${png.height} px does not fit. ${ART_HINT}` };
  const asset: DraftAsset = {
    name: file,
    slot: 'source',
    scale: 1,
    size: bytes.length,
    width: png.width,
    height: png.height,
    upload: toBase64(bytes),
  };
  return png.width < SOFT
    ? { ok: true, asset, warning: 'Under 256 px, stamps may look soft.' }
    : { ok: true, asset };
}
