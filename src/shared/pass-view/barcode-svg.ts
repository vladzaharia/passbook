import {
  azteccode,
  code39,
  code128,
  drawingSVG,
  ean13,
  interleaved2of5,
  pdf417,
  qrcode,
  rationalizedCodabar,
} from 'bwip-js/generic';

type Encoder = (options: never, drawing: ReturnType<typeof drawingSVG>) => string;

/** Named encoders only: the generic entry point bundles all 100+ symbologies. Keyed like BARCODE_FORMATS. */
const ENCODERS: Record<string, Encoder> = {
  qrcode,
  pdf417,
  azteccode,
  code128,
  code39,
  rationalizedCodabar,
  ean13,
  interleaved2of5,
} as Record<string, Encoder>;

/** SVG for a bwip-js options object; `bcid` must be one of the pass barcode formats. */
export function toSvg(options: Record<string, unknown>): string {
  const encoder = typeof options.bcid === 'string' ? ENCODERS[options.bcid] : undefined;
  if (!encoder) throw new Error(`Unsupported barcode: ${String(options.bcid)}`);
  return encoder(options as never, drawingSVG());
}
