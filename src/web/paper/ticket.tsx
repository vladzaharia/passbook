import type { CSSProperties } from 'react';
import { PAPER_SPECS, type PaperDesign } from '../../passkit/template/paper.ts';
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { groupPrintCode, PRINT_COPY } from '../../shared/copy/print.ts';
import type { PaperDrawing } from './drawing.ts';

const LABEL: Record<PaperDrawing['kind'], string> = { qr: 'QR code', code128: 'Code 128 barcode' };

/** The code's size in mm: the symbol alone is `qrMm` (QR) or `barMm` (Code 128) wide. */
function codeStyle(design: PaperDesign, drawing: PaperDrawing): CSSProperties {
  const spec = PAPER_SPECS[design.size];
  const symbolMm = drawing.kind === 'qr' ? spec.qrMm : spec.barMm;
  const width = (symbolMm * drawing.whole) / drawing.symbol;
  const height = drawing.kind === 'qr' ? width : Math.max(12, symbolMm * 0.16);
  return {
    width: `calc(var(--mm) * ${width.toFixed(2)})`,
    height: `calc(var(--mm) * ${height.toFixed(2)})`,
  };
}

function CodeSvg({ design, drawing }: { design: PaperDesign; drawing: PaperDrawing }) {
  const [x, y, w, h] = drawing.viewBox.split(' ');
  return (
    <svg
      viewBox={drawing.viewBox}
      style={codeStyle(design, drawing)}
      role="img"
      aria-label={LABEL[drawing.kind]}
      preserveAspectRatio={drawing.kind === 'qr' ? 'xMidYMid meet' : 'none'}
      shapeRendering="crispEdges"
    >
      <rect x={x} y={y} width={w} height={h} fill="#fff" />
      {drawing.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          {...(path.strokeWidth
            ? { fill: 'none', stroke: '#000', strokeWidth: path.strokeWidth }
            : { fill: '#000', ...(path.fillRule ? { fillRule: 'evenodd' as const } : {}) })}
        />
      ))}
    </svg>
  );
}

/**
 * One printed ticket. Server and browser draw it from the same code, so the print page and the
 * designer's preview cannot drift. `code` is the print code; the page never gets the pass's own.
 */
export function PaperTicket({
  content,
  design,
  code,
  drawing,
}: {
  content: PaperContent;
  design: PaperDesign;
  code: string;
  drawing: PaperDrawing | undefined;
}) {
  const spec = PAPER_SPECS[design.size];
  // A card has no room for the type pill: it joins the lines under the date.
  const card = design.size === 'cr80';
  const info = [
    card && content.type ? { label: 'Type', text: content.type } : null,
    content.holder ? { label: 'Name', text: content.holder } : null,
    content.seat ? { label: 'Seat', text: content.seat } : null,
    ...content.extras.map((e) => ({ label: e.label ?? '', text: e.text })),
  ].filter((x): x is { label: string; text: string } => x !== null);
  const style = { '--w': spec.widthMm, '--h': spec.heightMm } as CSSProperties;
  return (
    <div className="pp-fit" data-size={design.size} style={style}>
      <article className={`pp-sheet pp-${design.size}`} data-barcode={design.barcode}>
        <header className="pp-head">
          <span className="pp-brand">{content.brand}</span>
          {content.type && !card ? <span className="pp-type">{content.type}</span> : null}
        </header>
        <div className="pp-body">
          <h2 className="pp-event">{content.event}</h2>
          {content.date ? <p className="pp-when">{content.date}</p> : null}
          {content.venue ? <p className="pp-venue">{content.venue}</p> : null}
          {info.length ? (
            <dl className="pp-info">
              {info.map((row) => (
                <div key={`${row.label}:${row.text}`}>
                  {row.label ? <dt>{row.label}</dt> : null}
                  <dd>{row.text}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <div className="pp-code-block">
          {drawing ? (
            <figure className="pp-figure">
              <CodeSvg design={design} drawing={drawing} />
            </figure>
          ) : (
            <p className="pp-missing" role="status">
              {PRINT_COPY.codeUnavailable}
            </p>
          )}
          <div className="pp-code-text">
            <p className="pp-code-label">{PRINT_COPY.code}</p>
            <p className="pp-code">{groupPrintCode(code)}</p>
            <p className="pp-note">{PRINT_COPY.codeNote}</p>
          </div>
        </div>
        {content.terms ? <p className="pp-terms">{content.terms}</p> : null}
      </article>
    </div>
  );
}
