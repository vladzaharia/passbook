import type { ImageSlot } from '../../../passkit/types.ts';
import { ValidationError } from '../../platform/errors.ts';
import { isPngInfo, parsePng } from '../templates/package/png.ts';

export const MAX_ASSET_BYTES = 1_000_000;

/** Largest @1x size per slot; @2x and @3x scale it. Icons must be square. */
const SLOT_LIMITS: Record<ImageSlot, { w: number; h: number; square?: boolean }> = {
  icon: { w: 38, h: 38, square: true },
  logo: { w: 160, h: 50 },
  primaryLogo: { w: 160, h: 80 },
  secondaryLogo: { w: 160, h: 80 },
  strip: { w: 375, h: 144 },
  thumbnail: { w: 90, h: 90 },
  artwork: { w: 540, h: 720 },
  background: { w: 345, h: 505 },
  footer: { w: 286, h: 15 },
  personalizationLogo: { w: 150, h: 40 },
  venueMap: { w: 375, h: 375 },
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

const COLOR_TYPES = [0, 2, 3, 4, 6];
const BIT_DEPTHS = [1, 2, 4, 8, 16];

/** Walks every chunk and CRC; requires IDAT and IEND. */
export function readPng(bytes: Uint8Array): PngInfo {
  const parsed = parsePng(bytes);
  if (!isPngInfo(parsed))
    throw new ValidationError(`The image is not a valid PNG. ${parsed.error}`, [], 'ASSET_NOT_PNG');
  if (!COLOR_TYPES.includes(parsed.colorType) || !BIT_DEPTHS.includes(parsed.bitDepth))
    throw new ValidationError('The PNG color format is not supported.', [], 'ASSET_NOT_PNG');
  return { width: parsed.width, height: parsed.height };
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
