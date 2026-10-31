import type { PassJson } from '../../passkit/types.ts';
import type { BarcodeView, PassTarget } from './types.ts';

interface Format {
  bcid: string;
  square: boolean;
  /** Minimum target that draws it; Wallet skips unknown formats and uses the next entry. */
  min: PassTarget;
}

export const BARCODE_FORMATS: Record<string, Format> = {
  PKBarcodeFormatQR: { bcid: 'qrcode', square: true, min: 'legacy' },
  PKBarcodeFormatPDF417: { bcid: 'pdf417', square: false, min: 'legacy' },
  PKBarcodeFormatAztec: { bcid: 'azteccode', square: true, min: 'legacy' },
  PKBarcodeFormatCode128: { bcid: 'code128', square: false, min: 'legacy' },
  PKBarcodeFormatCode39: { bcid: 'code39', square: false, min: 'ios27' },
  PKBarcodeFormatCodabar: { bcid: 'rationalizedCodabar', square: false, min: 'ios27' },
  PKBarcodeFormatEAN13: { bcid: 'ean13', square: false, min: 'ios27' },
  PKBarcodeFormatI2of5: { bcid: 'interleaved2of5', square: false, min: 'ios27' },
};

/** First barcode, in order, that the target can draw and that has a message. */
export function pickBarcode(pass: PassJson, target: PassTarget): BarcodeView | undefined {
  const list = [
    ...(Array.isArray(pass.barcodes) ? pass.barcodes : []),
    ...(pass.barcode && typeof pass.barcode === 'object' ? [pass.barcode as never] : []),
  ] as { format?: unknown; message?: unknown; altText?: unknown }[];
  for (const b of list) {
    const f = typeof b?.format === 'string' ? BARCODE_FORMATS[b.format] : undefined;
    if (!f || typeof b.message !== 'string' || b.message === '') continue;
    if (f.min === 'ios27' && target !== 'ios27') continue;
    return {
      format: b.format as string,
      bcid: f.bcid,
      message: b.message,
      square: f.square,
      ...(typeof b.altText === 'string' && b.altText ? { altText: b.altText } : {}),
    };
  }
  return undefined;
}
