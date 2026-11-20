import { concatTransformationMatrix, LineCapStyle, LineJoinStyle, setLineJoin } from 'pdf-lib';
import {
  BUDDY_LINE,
  BUDDY_PATHS,
  BUDDY_POSES,
  BUDDY_VIEWBOX,
  type BuddyPose,
  buddyPalette,
} from '../../../shared/paper-buddy.ts';
import { type Box, type Pen, PT } from './pdf-kit.ts';

const P = BUDDY_PATHS;
const W = BUDDY_LINE;
/** The viewBox is "0 -4 96 80": art units from the top-left of the box. */
const [, VY = -4, VW = 96] = BUDDY_VIEWBOX.split(' ').map(Number);

/** `#rrggbb`, `#rgb` or `rgb(r g b/a)` as a hex colour and an alpha; `none` is undefined. */
function paint(value: string): { hex: string; a: number } | undefined {
  if (value === 'none') return undefined;
  const m = /^rgb\((\d+) (\d+) (\d+)\/([\d.]+)\)$/.exec(value);
  if (!m) return { hex: value, a: 1 };
  const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return { hex: `#${hex}`, a: Number(m[4]) };
}

const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r);

/**
 * The buddy cameo: the product's geometry (shared/paper-buddy.ts), drawn static in the print
 * palette; mono is the line version. `box` is the 96 x 80 unit art scaled to its width.
 */
export function drawBuddy(pen: Pen, box: Box, pose: BuddyPose, mono: boolean): void {
  const c = buddyPalette(mono);
  const p = BUDDY_POSES[pose];
  const k = (box.w / VW) * PT;
  // Art units to page points: u right, v down, with the viewBox top at the box top.
  const left = pen.px(box.x);
  const origin = pen.py(box.y) + VY * k;

  const shape = (
    d: string,
    o: { fill?: string; stroke?: string; w?: number; dash?: [number, number]; opacity?: number },
  ) => {
    const f = o.fill ? paint(o.fill) : undefined;
    const s = o.stroke ? paint(o.stroke) : undefined;
    if (!f && !s) return;
    pen.page.drawSvgPath(d, {
      x: 0,
      y: 0,
      scale: 1,
      ...(f ? { color: pen.color(f.hex), opacity: f.a * (o.opacity ?? 1) } : {}),
      ...(s
        ? {
            borderColor: pen.color(s.hex),
            borderWidth: o.w ?? W,
            borderOpacity: s.a * (o.opacity ?? 1),
            borderLineCap: LineCapStyle.Round,
            ...(o.dash ? { borderDashArray: o.dash } : {}),
          }
        : {}),
    });
  };
  const group = (draw: () => void, a = 1, b = 0, cc = 0, d = 1, e = 0, f = 0) => {
    pen.save(draw, concatTransformationMatrix(a, b, cc, d, e, f));
  };
  // rotate(deg cx cy) in art space (y down) as a matrix in the y-up local space.
  const rotate = (deg: number, draw: () => void) => {
    const a = (-deg * Math.PI) / 180;
    const cx = 48;
    const cy = -64;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    group(draw, cos, sin, -sin, cos, cx - (cx * cos - cy * sin), cy - (cx * sin + cy * cos));
  };
  const card = (fillColor: string, extra?: () => void) => {
    shape(P.card, { fill: fillColor, stroke: c.line });
    shape(P.highlight, { stroke: c.highlight });
    extra?.();
  };
  const mark = (d: string, w = 2.2) => shape(d, { stroke: c.mark, w });

  pen.save(
    () => {
      shape(P.legLeft, { fill: c.body, stroke: c.line });
      shape(P.legRight, { fill: c.body, stroke: c.line });
      rotate(p.wave ? -52 : -18, () => card(c.passes[0]));
      rotate(18, () => card(c.passes[2]));
      group(
        () =>
          card(c.passes[1], () => {
            if (pose === 'coupon') {
              mark(P.percent[0]);
              mark(circle(44.5, 18.5, 2.2));
              mark(circle(51.5, 27.5, 2.2));
            } else if (pose === 'ready') mark(P.check, 2.6);
          }),
        1,
        0,
        0,
        1,
        0,
        p.lift,
      );
      shape(rect(16, 30, 64, 36, 9), { fill: c.body, stroke: c.line });
      shape(rect(20, 34, 56, 28, 6), { stroke: c.line, w: W * 0.8, dash: [2, 2.5], opacity: 0.7 });
      shape(rect(36, 37, 24, 16, 7), { fill: c.screenFill, stroke: c.screen });
      group(
        () => {
          if (p.joy) shape(P.joy, { stroke: c.face });
          else {
            shape(ellipse(43.5, 43.5, 1.7, 2.1), { fill: c.face });
            shape(ellipse(52.5, 43.5, 1.7, 2.1), { fill: c.face });
          }
        },
        1,
        0,
        0,
        1,
        p.wave ? -1.6 : 0,
        p.wave ? 1.4 : 0,
      );
      shape(p.bigSmile ? P.bigSmile : P.smile, { stroke: c.face });
    },
    setLineJoin(LineJoinStyle.Round),
    concatTransformationMatrix(k, 0, 0, k, left, origin),
  );
}
