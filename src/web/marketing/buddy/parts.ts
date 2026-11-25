import { B, BT, barcode, c, G, g, K, O, P, p, r, S, sk, T, V, W } from './svg.ts';

const MINI =
  r(4, 4, 7, 7, 1.8, G) +
  p('M14 7.5h17', W, 1.8) +
  r(0.5, 15, 35, 7, 0, W, ' fill-opacity=".1"') +
  p('M4 29h21', W, 2.6) +
  p('M4 35h9M17 35h9', '#cdb9ff', 1.3) +
  r(12, 39, 12, 10, 1.5, W);
/* pass({x,y,w,h,tone:'violet'|'teal'|'navy'|'blue', body}) a foil-edged pass; body '' for a blank face */
/** Options shared by the part builders; each reads the ones it needs. */
export type Part = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  tone?: string;
  body?: string;
  edge?: number;
  ground?: string;
  screen?: string;
  inside?: string;
  r?: number;
  s?: number;
  spin?: string;
};

export function pass(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    w = o.w || 36,
    h = o.h || 52,
    rx = Math.min(4, w / 8),
    t = o.tone || 'violet';
  return (
    r(x, y, w, h, rx, `url(#pb-${t})`, ` stroke="url(#pb-foil)" stroke-width="${o.edge || 1}"`) +
    r(x, y, w, h, rx, 'url(#pb-sheen)') +
    (o.body === undefined ? g(`translate(${x} ${y}) scale(${w / 36} ${h / 52})`, MINI) : o.body)
  );
}
/* ticket({x,y,w,h,ground}) a printed paper ticket with a tear-off stub; ground = colour behind it, for the notches */
export function ticket(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    w = o.w || 36,
    h = o.h || 52,
    k = o.ground || K;
  if (w > h) {
    const sx = x + w * 0.76;
    return (
      r(x, y, w, h, 5, '#f6ecd9', sk(1.4, K)) +
      r(x, y, sx - x, h * 0.28, 5, V) +
      r(x, y + h * 0.16, sx - x, h * 0.12, 0, V) +
      c(sx, y, h * 0.1, k) +
      c(sx, y + h, h * 0.1, k) +
      p(`M${sx} ${y + h * 0.16}v${h * 0.68}`, K, 1.3, ' stroke-dasharray="3 3"') +
      p(`M${x + 10} ${y + h * 0.46}h${w * 0.36}`, K, 3) +
      p(`M${x + 10} ${y + h * 0.62}h${w * 0.24}`, '#7e8699', 2) +
      barcode(x + 10, y + h * 0.8, w * 0.44, h * 0.16) +
      p(
        `M${sx + w * 0.1} ${y + h * 0.25}v${h * 0.5}`,
        K,
        w * 0.045,
        ` stroke-dasharray="2 1.5 1 1.5 3 1"${BT}`,
      )
    );
  }
  return (
    r(x, y, w, h, 3, '#f6ecd9') +
    r(x, y, w, h * 0.23, 3, G) +
    r(x, y + h * 0.15, w, h * 0.08, 0, G) +
    c(x, y + h * 0.6, 3.5, k) +
    c(x + w, y + h * 0.6, 3.5, k) +
    p(`M${x + 5} ${y + h * 0.6}h${w - 10}`, '#7e8699', 1.1, ' stroke-dasharray="2 2"') +
    p(`M${x + 5} ${y + h * 0.37}h${w * 0.5}`, K, 2.2) +
    barcode(x + 6, y + h * 0.81, w - 12, h * 0.15)
  );
}
/* phone({x,y,w,h,screen,inside}) a plain rounded phone; inside is drawn on the screen */
export function phone(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    w = o.w || 34,
    h = o.h || 52;
  return (
    r(x, y, w, h, w / 5.5, K, sk(1.2, S)) +
    r(x + 4, y + 7, w - 8, h - 12, w / 9, o.screen || '#1b2130') +
    r(x + w / 2 - 6, y + 2.6, 12, 2.2, 1.1, S) +
    (o.inside || '')
  );
}
/* tapCard({x,y,w,h}) a tap card with chip and rings */
export function tapCard(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    w = o.w || 62,
    h = o.h || 40,
    s = Math.min(w, h) / 40;
  return (
    pass({ x: x, y: y, w: w, h: h, tone: o.tone || 'teal', body: '' }) +
    r(x + 7 * s, y + 7 * s, 11 * s, 8.5 * s, 2 * s, G) +
    p(`M${x + 7 * s} ${y + h - 12 * s}h${w * 0.4}`, W, 2.2 * s) +
    p(
      `M${x + w - 15 * s} ${y + 9 * s}a7 7 0 0 1 0 10M${x + w - 10 * s} ${y + 6 * s}a11 11 0 0 1 0 16`,
      W,
      1.6 * s,
    )
  );
}
/* wristband({x,y,s}) a tap wristband, centre x,y */
export function wristband(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    s = o.s || 1;
  return g(
    `translate(${x} ${y}) scale(${s})`,
    `<ellipse cx="0" cy="0" rx="22" ry="10"${sk(6, B)}/>${r(-10, -18, 20, 14, 4, B, sk(1.4, K))}${c(0, -11, 3, K)}`,
  );
}
/* pedestal({x,y}) a free-standing scanner post; x = centre, y = floor */
export function pedestal(o: Part) {
  const x = o.x || 0,
    y = o.y || 0;
  return (
    '<ellipse cx="' +
    x +
    '" cy="' +
    (y - 1) +
    '" rx="16" ry="2.4" fill="url(#pb-shadow)"/>' +
    r(x - 5, y - 54, 10, 54, 2, P, sk(1.2, S)) +
    r(x - 13, y - 6, 26, 6, 3, P, sk(1.2, S)) +
    r(x - 16, y - 78, 32, 26, 7, 'url(#pb-pk)', sk(1.4, S)) +
    r(x - 11, y - 73, 22, 13, 3, '#13383c', sk(1, T))
  );
}
/* reader({x,y}) a wall-mounted round reader on a post, y = floor */
export function reader(o: Part) {
  const x = o.x || 0,
    y = o.y || 0;
  return (
    r(x - 5, y - 66, 10, 66, 0, K) +
    r(x - 17, y - 86, 34, 22, 6, W, sk(2, K)) +
    c(x, y - 75, 3.5, T)
  );
}
export function clock(o: Part) {
  const x = o.x || 0,
    y = o.y || 0,
    rr = o.r || 18,
    sp = o.spin || 's-hand';
  return (
    c(x, y, rr, W, sk(rr / 7, K)) +
    p(
      `M${x} ${y - rr + 3}v3M${x} ${y + rr - 6}v3M${x - rr + 3} ${y}h3M${x + rr - 6} ${y}h3`,
      K,
      rr / 9,
    ) +
    p(`M${x} ${y}l${rr * 0.33} ${rr * 0.22}`, K, rr / 6) +
    g(
      '',
      p(
        `M${x} ${y - rr * 0.72}v${rr * 1.44}`,
        O,
        rr / 6,
        ` stroke-dasharray="${rr * 0.72} ${rr * 0.72}"`,
      ),
      sp,
    )
  );
}
export function plug(o: Part) {
  const x = o.x || 0,
    y = o.y || 0;
  return (
    p(`M${x - 22} ${y + 13}q14 2 18-6`, S, 2) +
    g(
      '',
      r(x - 4, y - 4, 10, 12, 2.5, '#2a3142', sk(1, S)) +
        p(`M${x + 6} ${y - 1}h5M${x + 6} ${y + 5}h5`, '#b5bed3', 1.6),
      'b-plug',
    ) +
    r(x + 20, y - 8, 9, 20, 3, '#e9edf8', sk(1.2, S)) +
    c(x + 24.5, y - 2, 1.1, K) +
    c(x + 24.5, y + 6, 1.1, K) +
    p(`M${x + 14} ${y - 12}l2 3-3 1 2 3`, G, 1.2)
  );
}
