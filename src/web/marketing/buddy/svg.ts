/* Palette and the tiny SVG string helpers every part is built from. */

export type N = number | string;
export type Scenes = Record<string, () => string>;

export const K = '#060912',
  P = '#0d111b',
  S = '#61697b',
  T = '#2dd4bf',
  V = '#9a5cff',
  G = '#ffc24d',
  O = '#ff6fa6',
  B = '#60a5fa',
  W = '#fff',
  OK = '#56d57b',
  L = 'var(--pb-leg,#dbe4ff)',
  BT = ' stroke-linecap="butt"';
export function sk(w?: number, c?: string) {
  c = c || K;
  return `${c.indexOf('var(') === 0 ? ` style="stroke:${c}"` : ` stroke="${c}"`} stroke-width="${w || 2}"`;
}
export function p(d: string, s?: string, w?: number, x?: string) {
  return `<path d="${d}"${sk(w, s)}${x || ''}/>`;
}
export function f(d: string, fl: string, x?: string) {
  return `<path d="${d}" fill="${fl}"${x || ''}/>`;
}
export function r(x: N, y: N, w: N, h: N, rx: number, fl: string, e?: string) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fl}"${e || ''}/>`;
}
export function c(x: N, y: N, rr: number, fl: string, e?: string) {
  return `<circle cx="${x}" cy="${y}" r="${rr}" fill="${fl}"${e || ''}/>`;
}
export function el(x: number, y: number, a: number, b: number, cl?: string) {
  return `<ellipse${cl ? ` class="${cl}"` : ''} cx="${x}" cy="${y}" rx="${a}" ry="${b}" fill="#fff"/>`;
}
export function g(t: string, b: string, cl?: string, st?: string) {
  return `<g${t ? ` transform="${t}"` : ''}${cl ? ` class="${cl}"` : ''}${st ? ` style="${st}"` : ''}>${b}</g>`;
}
export function tx(x: N, y: N, s: N, fl: string, t: string, e?: string) {
  return `<text x="${x}" y="${y}" font-size="${s}" fill="${fl}"${e || ''}>${t}</text>`;
}
export function esc(t: string) {
  return String(t).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch as '&'],
  );
}
export function svg(vb: string, body: string, cls?: string, label?: string) {
  return (
    '<svg class="art' +
    (cls ? ` ${cls}` : '') +
    '" viewBox="' +
    vb +
    '" preserveAspectRatio="xMidYMax meet" fill="none" stroke-linecap="round" stroke-linejoin="round"' +
    (label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true" focusable="false"') +
    '>' +
    body +
    '</svg>'
  );
}
export function barcode(x: number, y: number, w: number, h: number, col?: string) {
  return p(`M${x} ${y}h${w}`, col || K, h, ` stroke-dasharray="2 1.4 1 1.4 3 1.2 1 2"${BT}`);
}
export function star(x: N, y: N, s: number, fl: string, cl?: string) {
  return f(
    'M0-8L2-2 8 0 2 2 0 8-2 2-8 0-2-2Z',
    fl,
    ` transform="translate(${x} ${y}) scale(${s})"${cl ? ` class="${cl}"` : ''}`,
  );
}
export function star5(x: number, y: number, fl: string, s?: number) {
  return f(
    'M0-7L1.65-2.27 6.66-2.16 2.66.87 4.11 5.66 0 2.8-4.11 5.66-2.66.87-6.66-2.16-1.65-2.27Z',
    fl,
    ` transform="translate(${x} ${y}) scale(${s || 1})"`,
  );
}
export function legs(w: number, h: number, col?: string) {
  return p(`M${w * 0.32} ${h}v9h-3.5M${w * 0.68} ${h}v9h3.5`, col || L, 2.4);
}
export function check(x: number, y: number, rr: number, cl?: string) {
  return g(
    '',
    c(x, y, rr, OK, sk(rr / 5, K)) +
      p(
        `M${x - rr * 0.5} ${y + rr * 0.04}l${rr * 0.37} ${rr * 0.37} ${rr * 0.67}-${rr * 0.7}`,
        K,
        rr / 4,
      ),
    cl,
  );
}
export function qr(x: number, y: number, s: number) {
  return `<use href="#pb-qr" fill="#0d1322" transform="translate(${x} ${y}) scale(${s})"/>`;
}
