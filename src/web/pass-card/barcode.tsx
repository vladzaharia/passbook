import bwip from 'bwip-js/generic';
import type { BarcodeView } from '../../shared/pass-view/index.ts';

const LINEAR = new Set(['code128', 'code39', 'ean13', 'interleaved2of5', 'rationalizedCodabar']);

interface Parsed {
  viewBox: string;
  paths: { d: string; strokeWidth?: string; fillRule?: string }[];
}

/** Read bwip-js output into plain data so the SVG renders without innerHTML. */
function parse(svg: string): Parsed | undefined {
  const vb = /viewBox="(\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?)"/.exec(svg);
  if (!vb) return undefined;
  const paths: Parsed['paths'] = [];
  for (const m of svg.matchAll(/<path\b([^>]*?)\/>/g)) {
    const attrs = m[1] ?? '';
    const d = /\sd="([MLHVZmlhvz0-9.\s-]+)"/.exec(attrs)?.[1];
    if (!d) continue;
    paths.push({
      d,
      ...(/\sstroke-width="(\d+(?:\.\d+)?)"/.test(attrs)
        ? { strokeWidth: /\sstroke-width="(\d+(?:\.\d+)?)"/.exec(attrs)?.[1] as string }
        : {}),
      ...(/fill-rule="evenodd"/.test(attrs) ? { fillRule: 'evenodd' } : {}),
    });
  }
  return paths.length ? { viewBox: vb[1] as string, paths } : undefined;
}

export function drawBarcode(b: BarcodeView): Parsed | undefined {
  try {
    const svg = bwip.toSVG({
      bcid: b.bcid,
      text: b.message,
      paddingwidth: 0,
      paddingheight: 0,
      ...(LINEAR.has(b.bcid) ? { height: 12 } : {}),
    });
    return parse(svg);
  } catch {
    // Bad data for the symbology (e.g. EAN-13 length): the caller shows a text fallback.
    return undefined;
  }
}

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

export function BarcodeSvg({ barcode }: { barcode: BarcodeView }) {
  const drawn = drawBarcode(barcode);
  const name = NAMES[barcode.bcid] ?? barcode.bcid;
  return (
    <figure className="pc-barcode" data-square={barcode.square} data-format={barcode.bcid}>
      {drawn ? (
        <svg
          className="pc-barcode-svg"
          viewBox={drawn.viewBox}
          role="img"
          aria-label={`${name} barcode, approximate rendering`}
          preserveAspectRatio="xMidYMid meet"
          shapeRendering="crispEdges"
        >
          {drawn.paths.map((p) => (
            <path
              key={p.d}
              d={p.d}
              {...(p.strokeWidth
                ? { fill: 'none', stroke: 'currentColor', strokeWidth: p.strokeWidth }
                : {
                    fill: 'currentColor',
                    ...(p.fillRule ? { fillRule: 'evenodd' as const } : {}),
                  })}
            />
          ))}
        </svg>
      ) : (
        <p className="pc-barcode-error" role="img" aria-label={`${name} barcode unavailable`}>
          {name} barcode unavailable
        </p>
      )}
      <figcaption className="pc-barcode-caption">
        {barcode.altText ? <span>{barcode.altText}</span> : null}
        <span className="pc-sr">Approximate preview, not for scanning.</span>
      </figcaption>
    </figure>
  );
}
