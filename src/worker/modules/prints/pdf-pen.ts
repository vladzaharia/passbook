/**
 * Drawing primitives for the printed ticket PDF. Everything is in millimetres from the sheet's
 * top-left corner, the way the layout boxes (paper-geometry.ts) and the print page's CSS are.
 */
import {
  appendBezierCurve,
  type Color,
  clip,
  closePath,
  endPath,
  fill,
  fillAndStroke,
  grayscale,
  LineCapStyle,
  type PDFImage,
  type PDFName,
  type PDFOperator,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setDashPattern,
  setFillingColor,
  setGraphicsState,
  setLineCap,
  setLineWidth,
  setStrokingColor,
  stroke,
  lineTo as toLine,
  moveTo as toMove,
} from 'pdf-lib';
import type { FontKey, PdfFonts } from './pdf-fonts.ts';
import { gstate } from './pdf-gstate.ts';

export const PT = 72 / 25.4;
export const COLORS = {
  ink: '#000000',
  text: '#14171F',
  muted: '#4A5163',
  rule: '#9CA3B1',
  hair: '#C9CED8',
  wash: '#F1F3F7',
  white: '#FFFFFF',
} as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextStyle {
  /** Font size in mm. */
  size: number;
  font: FontKey;
  color: string;
  /** Letter spacing in em. */
  ls?: number;
  upper?: boolean;
  /** Line height as a multiple of the size; default 1.3 like the print page. */
  lh?: number;
}

const KAPPA = 0.5522847498;

/** `#rrggbb` or `#rgb` as 0..255 components. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Colours, paths, clipping, transparency and images; `Pen` adds text. */
export class PenBase {
  readonly h: number;
  private readonly states = new Map<string, PDFName>();
  readonly page: PDFPage;
  readonly fonts: PdfFonts;
  /** Mono prints no colour operator: every colour is converted to grey. */
  readonly mono: boolean;
  readonly state: { lossy: boolean };

  constructor(
    page: PDFPage,
    fonts: PdfFonts,
    mono: boolean,
    state: { lossy: boolean },
    heightMm: number,
  ) {
    this.page = page;
    this.fonts = fonts;
    this.mono = mono;
    this.state = state;
    this.h = heightMm;
  }

  /** A colour for the page: grey in mono. */
  color(hex: string): Color {
    const [r, g, b] = parseHex(hex);
    if (this.mono || (r === g && g === b)) {
      const grey = this.mono ? (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 : r / 255;
      return grayscale(grey);
    }
    return rgb(r / 255, g / 255, b / 255);
  }

  px = (x: number) => x * PT;
  py = (y: number) => (this.h - y) * PT;

  ops(...ops: (PDFOperator | undefined)[]): void {
    this.page.pushOperators(...ops.filter((o): o is PDFOperator => o !== undefined));
  }

  /** Runs `draw` between save and restore of the graphics state. */
  save(draw: () => void, ...setup: PDFOperator[]): void {
    this.ops(pushGraphicsState(), ...setup);
    draw();
    this.ops(popGraphicsState());
  }

  /** An ExtGState operator for opacity, cached per page. */
  alpha(fillA: number, strokeA = fillA): PDFOperator {
    const key = `a${fillA}/${strokeA}`;
    let name = this.states.get(key);
    if (!name) {
      name = gstate(this.page, { ca: fillA, CA: strokeA });
      this.states.set(key, name);
    }
    return setGraphicsState(name);
  }

  /** A rounded rectangle as path operators; `r` is one radius or [tl, tr, br, bl] in mm. */
  rpath(b: Box, r: number | [number, number, number, number] = 0): PDFOperator[] {
    const radii = typeof r === 'number' ? [r, r, r, r] : r;
    const [tl = 0, tr = 0, br = 0, bl = 0] = radii.map((v) => v * PT);
    const x0 = this.px(b.x);
    const x1 = this.px(b.x + b.w);
    const yT = this.py(b.y);
    const yB = this.py(b.y + b.h);
    if (tl + tr + br + bl === 0) return [rectangle(x0, yB, x1 - x0, yT - yB)];
    const k = KAPPA;
    const ops = [toMove(x0 + tl, yT), toLine(x1 - tr, yT)];
    if (tr) ops.push(appendBezierCurve(x1 - tr + tr * k, yT, x1, yT - tr + tr * k, x1, yT - tr));
    ops.push(toLine(x1, yB + br));
    if (br) ops.push(appendBezierCurve(x1, yB + br - br * k, x1 - br + br * k, yB, x1 - br, yB));
    ops.push(toLine(x0 + bl, yB));
    if (bl) ops.push(appendBezierCurve(x0 + bl - bl * k, yB, x0, yB + bl - bl * k, x0, yB + bl));
    ops.push(toLine(x0, yT - tl));
    if (tl) ops.push(appendBezierCurve(x0, yT - tl + tl * k, x0 + tl - tl * k, yT, x0 + tl, yT));
    ops.push(closePath());
    return ops;
  }

  /** Fills a box; `opacity` below 1 uses a transparency state. */
  fillBox(b: Box, color: string, r: number | [number, number, number, number] = 0, opacity = 1) {
    this.save(
      () => this.ops(...this.rpath(b, r), fill()),
      setFillingColor(this.color(color)),
      ...(opacity < 1 ? [this.alpha(opacity)] : []),
    );
  }

  /** Fills a box through a soft mask (see fadeState). */
  fillMasked(
    b: Box,
    color: string,
    mask: PDFName,
    r: number | [number, number, number, number] = 0,
  ) {
    this.save(
      () => this.ops(...this.rpath(b, r), fill()),
      setFillingColor(this.color(color)),
      setGraphicsState(mask),
    );
  }

  /** The half of a disc on one side of its centre line, filled and with its arc outlined. */
  halfDisc(
    cx: number,
    cy: number,
    r: number,
    side: 'below' | 'above',
    fillColor: string,
    lineColor: string,
    width: number,
  ) {
    const R = r * PT;
    const X = this.px(cx);
    const Y = this.py(cy);
    const k = KAPPA * R;
    const d = side === 'below' ? -1 : 1;
    const arc = [
      toMove(X - R, Y),
      appendBezierCurve(X - R, Y + d * k, X - k, Y + d * R, X, Y + d * R),
      appendBezierCurve(X + k, Y + d * R, X + R, Y + d * k, X + R, Y),
    ];
    this.save(() => this.ops(...arc, closePath(), fill()), setFillingColor(this.color(fillColor)));
    this.save(
      () => this.ops(...arc, stroke()),
      setStrokingColor(this.color(lineColor)),
      setLineWidth(width * PT),
    );
  }

  /** Strokes a box; the line sits on the edge, centred. */
  strokeBox(
    b: Box,
    color: string,
    width: number,
    r: number | [number, number, number, number] = 0,
    dash?: [number, number],
  ) {
    this.save(
      () => this.ops(...this.rpath(b, r), stroke()),
      setStrokingColor(this.color(color)),
      setLineWidth(width * PT),
      ...(dash ? [setDashPattern([dash[0] * PT, dash[1] * PT], 0)] : []),
    );
  }

  fillStrokeBox(b: Box, fillColor: string, line: string, width: number, r = 0) {
    this.save(
      () => this.ops(...this.rpath(b, r), fillAndStroke()),
      setFillingColor(this.color(fillColor)),
      setStrokingColor(this.color(line)),
      setLineWidth(width * PT),
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
    dash?: [number, number],
  ) {
    this.save(
      () => this.ops(toMove(this.px(x1), this.py(y1)), toLine(this.px(x2), this.py(y2)), stroke()),
      setStrokingColor(this.color(color)),
      setLineWidth(width * PT),
      ...(dash
        ? [setDashPattern([dash[0] * PT, dash[1] * PT], 0), setLineCap(LineCapStyle.Butt)]
        : []),
    );
  }

  /** Clips to a box for the duration of `draw`. */
  clipped(b: Box, draw: () => void, r: number | [number, number, number, number] = 0) {
    this.save(draw, ...this.rpath(b, r), clip(), endPath());
  }

  // Images

  image(img: PDFImage, b: Box, opacity = 1) {
    this.page.drawImage(img, {
      x: this.px(b.x),
      y: this.py(b.y + b.h),
      width: b.w * PT,
      height: b.h * PT,
      ...(opacity < 1 ? { opacity } : {}),
    });
  }

  /** `object-fit: cover` into a box, positioned by fractions (0 left/top, 1 right/bottom). */
  cover(img: PDFImage, b: Box, posX = 0.5, posY = 0.5, opacity = 1) {
    const s = Math.max(b.w / img.width, b.h / img.height);
    const w = img.width * s;
    const h = img.height * s;
    this.clipped(b, () =>
      this.image(img, { x: b.x - (w - b.w) * posX, y: b.y - (h - b.h) * posY, w, h }, opacity),
    );
  }

  /** `object-fit: contain`, centred in the box. */
  contain(img: PDFImage, b: Box) {
    const s = Math.min(b.w / img.width, b.h / img.height);
    const w = img.width * s;
    const h = img.height * s;
    this.image(img, { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h });
  }
}
