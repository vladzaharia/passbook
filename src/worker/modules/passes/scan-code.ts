import type { PassJson } from '../../../passkit/types.ts';
import { fromBase64Url, sha256Hex, toBase32 } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** 128 random bits as 26 base32 characters (A-Z, 2-7): QR-alphanumeric friendly. */
export function newScanCode(ctx: ServiceContext): string {
  return toBase32(fromBase64Url(ctx.ids.token(16)));
}

/** The message of the primary barcode: `barcodes[0]`, else the legacy `barcode`. */
export function primaryBarcodeMessage(pass: PassJson): string | null {
  const record = pass as { barcodes?: { message?: unknown }[]; barcode?: { message?: unknown } };
  const message = record.barcodes?.[0]?.message ?? record.barcode?.message;
  return typeof message === 'string' && message !== '' ? message : null;
}

/** SHA-256 hex of the primary barcode message, or null when the pass has none. */
export async function barcodeHashOf(pass: PassJson): Promise<string | null> {
  const message = primaryBarcodeMessage(pass);
  return message === null ? null : sha256Hex(message);
}
