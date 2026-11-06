import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { sha256Hex } from '../../platform/ids.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const SCAN_CODE = /^[A-Z2-7]{26}$/;

/** A wedge reader appends CR, LF or Tab; a camera adds nothing. Drops control characters, then trims. */
export const cleanCode = (raw: string): string => raw.replace(CONTROLS, '').trim();

/** The scan code a typed or read string stands for, or null when it is not shaped like one. */
export function codeKeyOf(clean: string): string | null {
  const key = clean.toUpperCase().replace(/[\s-]/g, '');
  return SCAN_CODE.test(key) ? key : null;
}

/** SHA-256 hex of the trimmed UTF-8 string: the same hash the publish writes to `barcode_hash`. */
export const barcodeHashOfCode = (clean: string): Promise<string> => sha256Hex(clean);

/** C7: `lookup_hash` is SHA-256 of the normalized member, card or ticket number. */
export const lookupHashOf = (value: string): Promise<string> => sha256Hex(normalizeLookup(value));
