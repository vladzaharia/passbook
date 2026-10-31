import type { ImageSlot } from '../../../passkit/types.ts';
import { ValidationError } from '../../platform/errors.ts';

export const MAX_ASSET_BYTES = 1_000_000;

/** Largest @1x size per slot; @2x and @3x scale it. Icons must be square. */
const SLOT_LIMITS: Record<ImageSlot, { w: number; h: number; square?: boolean }> = {
  icon: { w: 29, h: 29, square: true },
  logo: { w: 160, h: 50 },
  primaryLogo: { w: 160, h: 80 },
  secondaryLogo: { w: 160, h: 80 },
  strip: { w: 375, h: 144 },
  thumbnail: { w: 90, h: 90 },
  artwork: { w: 540, h: 720 },
  background: { w: 180, h: 220 },
  footer: { w: 286, h: 15 },
};

export interface ParsedAssetName {
  slot: ImageSlot;
  scale: 1 | 2 | 3;
}

export function parseAssetName(name: string): ParsedAssetName {
  const match = /^([a-zA-Z]+)(?:@([23])x)?\.png$/.exec(name);
  const slot = match?.[1] as ImageSlot | undefined;
  if (!match || !slot || !(slot in SLOT_LIMITS)) {
    throw new ValidationError(`Unknown image slot in ${name}.`, [], 'ASSET_SLOT');
  }
  return { slot, scale: match[2] === '3' ? 3 : match[2] === '2' ? 2 : 1 };
}

export interface PngInfo {
  width: number;
  height: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function readPng(bytes: Uint8Array): PngInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid =
    bytes.length >= 33 &&
    SIGNATURE.every((b, i) => bytes[i] === b) &&
    view.getUint32(8) === 13 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
  if (!valid) throw new ValidationError('The image is not a PNG.', [], 'ASSET_NOT_PNG');
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Checks the PNG against the slot rules for its name. */
export function validateAsset(name: string, bytes: Uint8Array): PngInfo & ParsedAssetName {
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
    throw new ValidationError('The image must be 1 MB or smaller.', [], 'ASSET_SIZE');
  }
  const parsed = parseAssetName(name);
  const info = readPng(bytes);
  const limit = SLOT_LIMITS[parsed.slot];
  const maxW = limit.w * parsed.scale;
  const maxH = limit.h * parsed.scale;
  if (info.width < 1 || info.height < 1 || info.width > maxW || info.height > maxH) {
    throw new ValidationError(
      `${name} must be at most ${maxW}x${maxH}px.`,
      [{ path: name, message: `${info.width}x${info.height}`, code: 'ASSET_DIMENSIONS' }],
      'ASSET_DIMENSIONS',
    );
  }
  if (limit.square && info.width !== info.height) {
    throw new ValidationError(`${name} must be square.`, [], 'ASSET_DIMENSIONS');
  }
  return { ...info, ...parsed };
}
