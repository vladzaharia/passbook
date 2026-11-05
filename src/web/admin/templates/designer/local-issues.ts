import type { ValidationIssue } from '@/passkit/types.ts';
import type { DesignDoc } from './model.ts';
import { readBarcode } from './ops-more.ts';

export const BARCODE_TEXT_EMPTY = 'Enter the barcode text, or pick an input.';

/** True when the barcode is on, takes fixed text, and that text is blank. */
export function barcodeTextMissing(doc: DesignDoc): boolean {
  const s = readBarcode(doc);
  return s.enabled && s.message.kind === 'static' && s.staticMessage.trim() === '';
}

/** Problems the server's dry run cannot see: it only reads the pass the bindings leave behind. */
export function localIssues(doc: DesignDoc): ValidationIssue[] {
  return barcodeTextMissing(doc)
    ? [
        {
          severity: 'error',
          code: 'BARCODE_EMPTY',
          message: BARCODE_TEXT_EMPTY,
          path: 'barcodes.0.message',
        },
      ]
    : [];
}
