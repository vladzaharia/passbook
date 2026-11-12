import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { type BarcodeDrawing, parseBarcodeSvg } from '../../web/pass-card/barcode.tsx';
import type { PresentationBarcode } from '../modules/public/presentation.ts';
import { encodePresentationText } from './presentation-encoding.ts';

const LINEAR: Record<string, true> = {
  code128: true,
  code39: true,
  ean13: true,
  interleaved2of5: true,
  rationalizedCodabar: true,
};
const NAMES: Record<string, string> = {
  qrcode: 'QR',
  pdf417: 'PDF417',
  azteccode: 'Aztec',
  code128: 'Code 128',
  code39: 'Code 39',
  ean13: 'EAN-13',
  interleaved2of5: 'ITF',
  rationalizedCodabar: 'Codabar',
};

/** A dedicated, high-contrast drawing; the pass-card drawing remains a preview. */
export function PresentationCode({ barcode }: { barcode: PresentationBarcode | null }) {
  const text = barcode ? encodePresentationText(barcode.message, barcode.encoding) : null;
  let drawing: BarcodeDrawing | undefined;
  if (barcode && text !== null) {
    try {
      drawing = parseBarcodeSvg(
        toSvg({
          bcid: barcode.bcid,
          text,
          binarytext: true,
          paddingwidth: 0,
          paddingheight: 0,
          ...(LINEAR[barcode.bcid] ? { height: 22 } : {}),
        }),
      );
    } catch {
      // The stored message cannot be represented by its declared symbology.
    }
  }
  if (!barcode || !drawing) {
    return (
      <div className="presentation-unavailable" role="status">
        <h2>Barcode unavailable</h2>
        <p>Contact the organization that issued this pass for help.</p>
      </div>
    );
  }
  const name = NAMES[barcode.bcid] ?? 'Pass';
  return (
    <figure className="presentation-figure" data-format={barcode.bcid}>
      <div className="presentation-code" data-square={barcode.square}>
        <svg
          viewBox={drawing.viewBox}
          role="img"
          aria-label={`${name} presentation barcode`}
          preserveAspectRatio="xMidYMid meet"
          shapeRendering="crispEdges"
        >
          {drawing.paths.map((path) => (
            <path
              key={path.d}
              d={path.d}
              {...(path.strokeWidth
                ? { fill: 'none', stroke: 'currentColor', strokeWidth: path.strokeWidth }
                : {
                    fill: 'currentColor',
                    ...(path.fillRule ? { fillRule: 'evenodd' as const } : {}),
                  })}
            />
          ))}
        </svg>
      </div>
      <figcaption>{name} presentation barcode · Show this to the reader when requested.</figcaption>
    </figure>
  );
}
