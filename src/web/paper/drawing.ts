import type { PaperBarcode } from '../../passkit/template/paper.ts';
import { type BarcodeDrawing, parseBarcodeSvg } from '../pass-card/barcode.tsx';
import type { ToSvg } from '../pass-card/barcode-engine.ts';

/** A code ready to draw: its viewBox already holds the quiet zone (4 modules; 10 for Code 128). */
export interface PaperDrawing extends BarcodeDrawing {
  kind: PaperBarcode;
  /** The viewBox width of the symbol alone and of the whole drawing, so a size in mm can be set. */
  symbol: number;
  whole: number;
  /** The symbol's modules across, and the quiet zone around it in modules. */
  modules: number;
  quiet: number;
}

const QR_QUIET = 4;
const CODE128_QUIET = 10;
/** bwip-js draws a Code 128 module as 2 units at its default scale. */
const CODE128_MODULE = 2;

/** A QR module in drawing units: the first path is the 7-module finder pattern's outline. */
function qrModule(drawing: BarcodeDrawing, size: number): number {
  const d = drawing.paths[0]?.d ?? '';
  const edge = /^M0 [\d.]+L([\d.]+) /.exec(d)?.[1];
  return edge ? Number(edge) / 7 : size / 25;
}

/** Draws a print code as QR or Code 128, black on white, with its quiet zone. Undefined when it cannot. */
export function drawPaperCode(
  toSvg: ToSvg,
  kind: PaperBarcode,
  text: string,
): PaperDrawing | undefined {
  try {
    const svg = toSvg(
      kind === 'qr'
        ? { bcid: 'qrcode', text, eclevel: 'M', paddingwidth: 0, paddingheight: 0 }
        : { bcid: 'code128', text, height: 12, paddingwidth: 0, paddingheight: 0 },
    );
    const base = parseBarcodeSvg(svg);
    if (!base) return undefined;
    const [x, y, w, h] = base.viewBox.split(' ').map(Number) as [number, number, number, number];
    if (kind === 'qr') {
      const module = qrModule(base, w);
      const pad = QR_QUIET * module;
      return {
        ...base,
        kind,
        modules: Math.round(w / module),
        quiet: QR_QUIET,
        symbol: w,
        whole: w + 2 * pad,
        viewBox: `${x - pad} ${y - pad} ${w + 2 * pad} ${h + 2 * pad}`,
      };
    }
    const pad = CODE128_QUIET * CODE128_MODULE;
    return {
      ...base,
      kind,
      modules: Math.round(w / CODE128_MODULE),
      quiet: CODE128_QUIET,
      symbol: w,
      whole: w + 2 * pad,
      viewBox: `${x - pad} ${y} ${w + 2 * pad} ${h}`,
    };
  } catch {
    // The symbology cannot carry this text.
    return undefined;
  }
}
