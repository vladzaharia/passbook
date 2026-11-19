/** The parts every Google type carries the same way: barcode, colour, dates, locations, void state. */
import type { BarcodeKind, ViewBarcode } from '../types.ts';
import type { Ctx } from './ctx.ts';
import { BARCODE_MESSAGE, MAX_LOCATIONS, TEXT } from './limits.ts';
import type {
  GoogleBarcode,
  GoogleLatLong,
  GoogleMessage,
  GoogleState,
  GoogleTimeInterval,
} from './types.ts';
import { utc } from './values.ts';

const BARCODE_TYPES: Partial<Record<BarcodeKind, GoogleBarcode['type']>> = {
  qr: 'QR_CODE',
  pdf417: 'PDF_417',
  aztec: 'AZTEC',
  code128: 'CODE_128',
  code39: 'CODE_39',
  codabar: 'CODABAR',
  ean13: 'EAN_13',
};
/** Interleaved 2 of 5 is only offered as ITF-14, which is exactly 14 digits. */
const typeOf = (b: ViewBarcode): GoogleBarcode['type'] | undefined =>
  b.kind === 'i2of5'
    ? /^\d{14}$/u.test(b.message)
      ? 'ITF_14'
      : undefined
    : b.kind === 'other'
      ? undefined
      : BARCODE_TYPES[b.kind];
const NON_ASCII = /\P{ASCII}/u;

/**
 * The first Apple barcode Google can render, in Apple's order, with its message copied unchanged.
 * An earlier one that Google cannot render is reported. A voided pass carries none.
 */
export function barcodeOf(ctx: Ctx): GoogleBarcode | undefined {
  const { barcodes, validity } = ctx.view;
  if (barcodes.length === 0 || validity.voided) return undefined;
  const chosen = barcodes.findIndex((b) => b.kind !== 'other' && typeOf(b));
  for (const [i, b] of barcodes.entries()) {
    if (i === chosen || (chosen >= 0 && i > chosen)) break;
    ctx.note(
      b.kind === 'other' ? 'barcode.format' : `barcode.format.${b.kind}`,
      `barcodes.${i}`,
      'omitted',
      `${b.format.replace(/^PKBarcodeFormat/u, '')} is not offered by Google Wallet.`,
    );
  }
  const barcode = barcodes[chosen];
  if (!barcode || barcode.kind === 'other') return undefined;
  const path = `barcodes.${chosen}`;
  if (ctx.left('barcode.format', path)) return undefined;
  const type = typeOf(barcode) as GoogleBarcode['type'];
  if (barcode.kind === 'i2of5')
    ctx.note('barcode.format.i2of5', path, 'difference', 'Sent as ITF-14 (14 digits).');
  const value = ctx.identity(path, barcode.message, BARCODE_MESSAGE);
  if (NON_ASCII.test(value) && !/^utf-?8$/iu.test(barcode.encoding))
    ctx.note(
      `barcode.format.${barcode.kind}`,
      path,
      'difference',
      `The message is sent as UTF-8, not ${barcode.encoding}.`,
    );
  const out: GoogleBarcode = { type, renderEncoding: 'UTF_8', value };
  if (barcode.altText && !ctx.left('barcode.altText', path))
    out.alternateText = ctx.display(path, barcode.altText, TEXT.line);
  return out;
}

/** The background colour. Google picks the text colour, so a foreground or label colour is a difference. */
export function backgroundColor(ctx: Ctx): string | undefined {
  const { colors } = ctx.view;
  if (colors.foreground)
    ctx.note(
      'colors.foreground',
      '',
      'difference',
      'Google Wallet has no text colour field: it picks one.',
    );
  if (colors.label)
    ctx.note(
      'colors.label',
      '',
      'difference',
      'Google Wallet has no label colour field: it picks one.',
    );
  if (!colors.background || ctx.left('colors.background')) return undefined;
  return colors.background;
}

/** `validTimeInterval`: both bounds in UTC so they share one offset rule. */
export function timeInterval(
  ctx: Ctx,
  start: string | undefined,
  end: string | undefined,
): GoogleTimeInterval | undefined {
  const from = start && !ctx.left('relevance.dates', 'relevantDates') ? utc(start) : undefined;
  const to = end && !ctx.left('validity.expiration') ? utc(end) : undefined;
  if (!from && !to) return undefined;
  return { ...(from ? { start: { date: from } } : {}), ...(to ? { end: { date: to } } : {}) };
}

/** Relevance windows beyond the first cannot be carried; a type with no start time carries none. */
export function dateLosses(ctx: Ctx, carries: boolean): void {
  const { dates } = ctx.view.relevance;
  if (dates.length === 0) return;
  if (!carries)
    ctx.note('relevance.dates', 'relevantDates', 'omitted', 'This Google type has no start time.');
  else if (dates.length > 1)
    ctx.note(
      'relevance.dates',
      'relevantDates',
      'difference',
      'Google carries the first start time only.',
    );
}

/** Pass locations plus the venue, at most 10 (extras are rejected by Google). */
export function locationsOf(ctx: Ctx): GoogleLatLong[] | undefined {
  const { relevance } = ctx.view;
  const points: GoogleLatLong[] = relevance.locations.map((l) => ({
    latitude: l.latitude,
    longitude: l.longitude,
  }));
  const venue = ctx.take('venueLocation');
  if (venue?.kind === 'location')
    if (!points.some((p) => p.latitude === venue.latitude && p.longitude === venue.longitude))
      points.push({ latitude: venue.latitude, longitude: venue.longitude });
  if (points.length > 0 && ctx.left('relevance.locations', 'locations')) return undefined;
  if (relevance.locations.some((l) => l.relevantText))
    ctx.note(
      'relevance.locations',
      'locations',
      'difference',
      'Google shows no text at a location.',
    );
  if (relevance.maxDistance !== undefined && points.length > 0)
    ctx.note('relevance.maxDistance', '', 'difference', 'Google sets the notification radius.');
  if (points.length > MAX_LOCATIONS)
    ctx.note(
      'relevance.locations',
      'locations',
      'omitted',
      `Google carries ${MAX_LOCATIONS} locations; ${points.length - MAX_LOCATIONS} left out.`,
    );
  return points.length > 0 ? points.slice(0, MAX_LOCATIONS) : undefined;
}

/** What Google has no slot for. */
export function unsupportedParts(ctx: Ctx): void {
  const { view } = ctx;
  if (view.relevance.beacons.length > 0)
    ctx.note('relevance.beacons', 'beacons', 'unsupported', 'Google Wallet has no beacons.');
  if (view.nfc) ctx.note('nfc', '', 'unsupported', 'Google Smart Tap is not set up.');
  if (view.personalization)
    ctx.note('personalization', '', 'unsupported', 'Google Wallet has no sign-up on the pass.');
}

export const voidedMessage: GoogleMessage = {
  id: 'voided',
  header: 'Pass voided',
  body: 'This pass is no longer valid.',
  messageType: 'TEXT',
};

/** A voided pass is INACTIVE with no barcode and one message (architecture 6.2, G5). */
export function stateOf(ctx: Ctx): { state: GoogleState; messages?: GoogleMessage[] } {
  return ctx.view.validity.voided
    ? { state: 'INACTIVE', messages: [voidedMessage] }
    : { state: 'ACTIVE' };
}
