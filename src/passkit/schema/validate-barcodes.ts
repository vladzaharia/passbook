import { BARCODE_FORMATS, LEGACY_BARCODE_FORMATS, NEW_BARCODE_FORMATS } from './constants.ts';
import { isObject, type ValidationContext } from './util.ts';

const FORMATS: readonly string[] = BARCODE_FORMATS;
// The symbology data rules are not Apple-documented, so mismatches warn.
const DATA_RULES: Record<string, [RegExp, string]> = {
  PKBarcodeFormatCode39: [/^[0-9A-Z \-.$/+%*]*$/, 'Code 39 encodes 0-9, A-Z, space and -.$/+%'],
  PKBarcodeFormatCodabar: [/^[A-Da-d]?[0-9\-$:/.+]*[A-Da-d]?$/, 'Codabar encodes 0-9 and -$:/.+'],
  PKBarcodeFormatEAN13: [/^(?:\d{12}|\d{13})$/, 'EAN-13 needs 12 or 13 digits'],
  PKBarcodeFormatI2of5: [/^(?:\d{2})*$/, 'ITF needs an even number of digits'],
};

function checkBarcode(ctx: ValidationContext, value: unknown, path: string, legacy: boolean): void {
  const { error, warn } = ctx;
  if (!isObject(value)) {
    error('BARCODE', 'Barcode must be an object.', path);
    return;
  }
  for (const key of Object.keys(value))
    if (!['format', 'message', 'messageEncoding', 'altText', '_id'].includes(key))
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
  const format = String(value.format);
  if (!FORMATS.includes(format)) {
    error('BARCODE_FORMAT', 'Unsupported barcode format.', `${path}.format`);
    return;
  }
  if (legacy && !LEGACY_BARCODE_FORMATS.has(format))
    error('BARCODE_FORMAT', 'barcode supports QR, PDF417 and Aztec only.', `${path}.format`);
  if (typeof value.message !== 'string' || typeof value.messageEncoding !== 'string') {
    error('BARCODE', 'Barcode needs message and messageEncoding.', path);
    return;
  }
  if (value.messageEncoding === '')
    error('BARCODE', 'messageEncoding must be an IANA charset name.', `${path}.messageEncoding`);
  if (value.altText !== undefined && typeof value.altText !== 'string')
    error('BARCODE', 'altText must be a string.', `${path}.altText`);
  const rule = DATA_RULES[format];
  if (rule && value.message !== '' && !rule[0].test(value.message))
    warn('BARCODE_DATA', `${rule[1]}.`, `${path}.message`);
}

export function validateBarcodes(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  if (pass.barcode !== undefined) {
    warn('BARCODE_DEPRECATED', 'barcode is deprecated; use barcodes.', 'barcode');
    checkBarcode(ctx, pass.barcode, 'barcode', true);
  }
  if (pass.barcodes === undefined) return;
  if (!Array.isArray(pass.barcodes)) {
    error('BARCODE', 'barcodes must be an array.', 'barcodes');
    return;
  }
  pass.barcodes.forEach((b: unknown, i) => {
    checkBarcode(ctx, b, `barcodes.${i}`, false);
  });
  const formats = pass.barcodes.map((b: unknown) => (isObject(b) ? String(b.format) : ''));
  formats.forEach((format, i) => {
    if (!NEW_BARCODE_FORMATS.has(format)) return;
    // iOS 26 and earlier skip these formats and show the next entry; none means no barcode.
    const fallback = formats
      .slice(i + 1)
      .some((f) => FORMATS.includes(f) && !NEW_BARCODE_FORMATS.has(f));
    if (!fallback)
      warn(
        'BARCODE_NO_FALLBACK',
        `${format.replace('PKBarcodeFormat', '')} needs a QR, PDF417, Aztec or Code 128 entry after it for iOS 26 and earlier.`,
        `barcodes.${i}`,
      );
  });
}
