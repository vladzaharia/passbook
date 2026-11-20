import {
  clipEvenOdd,
  degrees,
  endPath,
  rectangle,
  setCharacterSpacing,
  setLineWidth,
  setStrokingColor,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib';
import { PAPER_COPY } from '../../../shared/copy/print.ts';
import { drawable } from './pdf-fonts.ts';
import { type Box, COLORS, type Pen, PT, type TextStyle } from './pdf-kit.ts';

const STRIP: TextStyle = { size: 2.6106, font: 'bold', color: COLORS.ink, ls: 0.04 };
const HATCH = '#D5D9E1';

/** The hatched "TEST TICKET" strip above the code. Returns its height. */
export function testStrip(pen: Pen, x: number, y: number, w: number, size = STRIP.size): number {
  const st = { ...STRIP, size };
  const h = pen.lineHeight(st) + 2.4 + 0.6;
  const box = { x, y, w, h };
  pen.fillBox(box, COLORS.white, 1.2);
  pen.clipped(box, () => {
    // 135deg stripes of 1.6 mm: lines of constant x + y, 4.53 mm apart along the axis.
    for (let c = x + y + 2.26; c < x + y + w + h; c += 4.525)
      pen.line(c - y, y, c - (y + h), y + h, HATCH, 1.6);
  });
  pen.strokeBox(box, COLORS.ink, 0.3, 1.2);
  pen.text(PAPER_COPY.testStrip, x, y + 0.3 + 1.2, st, 'center', w);
  return h;
}

/**
 * "TEST · NOT VALID" in outline, three times across the page at -24 degrees, everywhere but
 * `keep` (the door panel), so a test print still scans on a test scanner.
 */
export function watermark(
  pen: Pen,
  page: { w: number; h: number },
  keep: Box,
  options: { size?: number; tops?: number[] } = {},
): void {
  const size = options.size ?? 15.5222;
  const face = pen.fonts.bold;
  const text = drawable(face, PAPER_COPY.testMark, pen.state);
  const ls = 0.12 * size;
  const width = face.font.widthOfTextAtSize(text, size * PT) / PT + ls * [...text].length;
  const a = (24 * Math.PI) / 180;
  const clip = [
    rectangle(0, 0, page.w * PT, page.h * PT),
    rectangle(pen.px(keep.x), pen.py(keep.y + keep.h), keep.w * PT, keep.h * PT),
    clipEvenOdd(),
    endPath(),
  ];
  pen.save(
    () => {
      for (const t of options.tops ?? [0.2, 0.52, 0.84]) {
        const cx = page.w / 2;
        const cy = t * page.h + (1.3 * size) / 2;
        const dx = -width / 2;
        const dy = -((face.ascent - face.descent) / 2) * size;
        const x = pen.px(cx + dx * Math.cos(a) - dy * Math.sin(a));
        const y = pen.py(cy) + (dx * Math.sin(a) + dy * Math.cos(a)) * PT;
        pen.save(
          () =>
            pen.page.drawText(text, {
              x,
              y,
              size: size * PT,
              font: face.font,
              rotate: degrees(24),
              color: pen.color(COLORS.ink),
            }),
          pen.alpha(1, 0.75),
          setTextRenderingMode(TextRenderingMode.Outline),
          setLineWidth(0.35 * PT),
          setStrokingColor(pen.color('#787E8C')),
          setCharacterSpacing(ls * PT),
        );
      }
    },
    ...clip,
  );
}
