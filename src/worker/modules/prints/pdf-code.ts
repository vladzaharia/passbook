import {
  beginMarkedContent,
  closePath,
  endMarkedContent,
  fill,
  lineTo,
  moveTo,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingGrayscaleColor,
} from 'pdf-lib';
import type { PaperSpec } from '../../../passkit/template/paper.ts';
import { codeSymbolMm } from '../../../passkit/template/paper-geometry-sizes.ts';
import type { PaperDrawing } from '../../../web/paper/drawing.ts';
import type { Box, Pen } from './pdf-kit.ts';

/** The marked-content tag around a code's operators, so a test can find them. */
export const CODE_TAG = 'PBCode';

const NUMBER_PAIR = /(-?[\d.]+)[ ,](-?[\d.]+)/g;

/** The code's size in mm: the symbol alone is `qrMm` or `barMm` wide, the quiet zone is extra. */
export function codeMm(spec: PaperSpec, drawing: PaperDrawing): { w: number; h: number } {
  const symbolMm = codeSymbolMm(spec, drawing.kind);
  const w = (symbolMm * drawing.whole) / drawing.symbol;
  return { w, h: drawing.kind === 'qr' ? w : Math.max(13, symbolMm * 0.22) };
}

/**
 * Draws the code, black on white with its quiet zone, as filled vector shapes centred on `centre`.
 * Returns the box drawn (quiet zone included).
 */
export function drawCode(
  pen: Pen,
  drawing: PaperDrawing,
  spec: PaperSpec,
  centre: Box,
  radius = 0,
): Box {
  const { w, h } = codeMm(spec, drawing);
  const box: Box = { x: centre.x + (centre.w - w) / 2, y: centre.y + (centre.h - h) / 2, w, h };
  const [vx = 0, vy = 0, vw = 1, vh = 1] = drawing.viewBox.split(' ').map(Number);
  const at = (u: number, v: number): [number, number] => [
    pen.px(box.x + ((u - vx) / vw) * box.w),
    pen.py(box.y + ((v - vy) / vh) * box.h),
  ];
  const shapes: PDFOperator[] = [];
  for (const path of drawing.paths) {
    if (path.strokeWidth) {
      // Code 128: each bar is a vertical stroke.
      const half = Number(path.strokeWidth) / 2;
      for (const m of path.d.matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g)) {
        const [x0, y0] = at(Number(m[1]) - half, Number(m[2]));
        const [x1, y1] = at(Number(m[3]) + half, Number(m[4]));
        shapes.push(rectangle(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0)));
      }
      shapes.push(fill());
      continue;
    }
    for (const part of path.d.split('Z')) {
      const points = [...part.matchAll(NUMBER_PAIR)].map(
        (m) => at(Number(m[1]), Number(m[2])) as [number, number],
      );
      const [first, ...rest] = points;
      if (!first || rest.length < 2) continue;
      shapes.push(moveTo(...first), ...rest.map((p) => lineTo(...p)), closePath());
    }
    shapes.push(
      PDFOperator.of(path.fillRule ? PDFOperatorNames.FillEvenOdd : PDFOperatorNames.FillNonZero),
    );
  }
  pen.fillBox(box, '#FFFFFF', radius);
  pen.ops(
    beginMarkedContent(CODE_TAG),
    pushGraphicsState(),
    setFillingGrayscaleColor(0),
    ...shapes,
    popGraphicsState(),
    endMarkedContent(),
  );
  return box;
}
