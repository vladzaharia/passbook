import { checkImageSize, IMAGE_RULES } from '../../../passkit/schema/image-rules.ts';
import { slotOf } from '../../../passkit/template/package.ts';
import type { ImageSlot } from '../../../passkit/types.ts';
import { ValidationError } from '../../platform/errors.ts';
import { isPngInfo, parsePng } from '../templates/package/png.ts';

export const MAX_ASSET_BYTES = 1_000_000;

/** The one slot table; pass overrides check against the same rules as the engine. */
export { IMAGE_RULES };

const SLOTS = new Set<string>([...Object.keys(IMAGE_RULES), 'venueMap']);

export interface ParsedAssetName {
  slot: ImageSlot;
  scale: 1 | 2 | 3;
}

export function parseAssetName(name: string): ParsedAssetName {
  const match = /^([a-zA-Z]+)(?:@([23])x)?\.png$/.exec(name);
  const slot = match?.[1] as ImageSlot | undefined;
  if (!match || !slot || !SLOTS.has(slot)) {
    throw new ValidationError(`Unknown image slot in ${name}.`, [], 'ASSET_SLOT');
  }
  return { slot, scale: match[2] === '3' ? 3 : match[2] === '2' ? 2 : 1 };
}

/**
 * Matches template files that pass overrides replace. An override replaces every scale and locale
 * of its slot; otherwise Wallet on a Retina device would pick the template's @2x/@3x file.
 */
export function replacedBy(overrideNames: Iterable<string>): (templateName: string) => boolean {
  const slots = new Set<string>();
  for (const name of overrideNames) slots.add(parseAssetName(name).slot);
  return (templateName) => {
    const slot = slotOf(templateName);
    return slot !== null && slots.has(slot);
  };
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

/** Checks the PNG against the slot rules for its name; an older legacy size passes. */
export function validateAsset(name: string, bytes: Uint8Array): PngInfo & ParsedAssetName {
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
    throw new ValidationError('The image must be 1 MB or smaller.', [], 'ASSET_SIZE');
  }
  const parsed = parseAssetName(name);
  const info = readPng(bytes);
  const verdict = checkImageSize(name, parsed.slot, parsed.scale, info.width, info.height);
  if (verdict.level === 'error') {
    throw new ValidationError(
      verdict.message,
      [
        {
          path: name,
          message: `${info.width} × ${info.height} px; expected ${verdict.expected}`,
          code: 'ASSET_DIMENSIONS',
        },
      ],
      'ASSET_DIMENSIONS',
    );
  }
  return { ...info, ...parsed };
}
