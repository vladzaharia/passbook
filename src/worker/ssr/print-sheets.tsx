import { renderToStaticMarkup } from 'react-dom/server';
import { PAPER_SIZES, PAPER_SPECS, type PaperDesign } from '../../passkit/template/paper.ts';
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { PAPER_CSS } from '../../web/paper/css.ts';
import { drawPaperCode } from '../../web/paper/drawing.ts';
import { PaperTicket } from '../../web/paper/ticket.tsx';

/** One ticket of a PDF: its design, words and the print code. */
export interface PrintSheet {
  design: PaperDesign;
  content: PaperContent;
  code: string;
}

/** Named pages: tickets of different sizes can share one document, each on a page of its own size. */
const PAGES = PAPER_SIZES.map((size) => {
  const s = PAPER_SPECS[size];
  return `@page pp-${size}{size:${s.widthMm}mm ${s.heightMm}mm;margin:0}.pp-fit[data-size=${size}]{page:pp-${size}}`;
}).join('');

const CSS = `${PAPER_CSS}${PAGES}
html,body{margin:0;background:#fff}
.pp-fit{break-after:page}
.pp-fit:last-child{break-after:auto}`;

/**
 * The document Browser Run prints: the sheets of the print page and nothing else (no chrome, no
 * script). Rendered with print media, so the sheet is its true size in mm.
 */
export function renderPrintSheets(sheets: readonly PrintSheet[]): string {
  const body = sheets
    .map((s) =>
      renderToStaticMarkup(
        <PaperTicket
          content={s.content}
          design={s.design}
          code={s.code}
          drawing={drawPaperCode(toSvg, s.design.barcode, s.code)}
        />,
      ),
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Tickets</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
