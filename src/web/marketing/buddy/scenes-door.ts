import { body, buddyAt, POSE_VB } from './body.ts';
import { pass, pedestal, phone, reader, tapCard, ticket, wristband } from './parts.ts';
import {
  B,
  BT,
  barcode,
  c,
  check,
  f,
  G,
  g,
  K,
  L,
  legs,
  O,
  OK,
  p,
  qr,
  r,
  type Scenes,
  sk,
  star,
  svg,
  T,
  tx,
  V,
  W,
} from './svg.ts';

function visitor(k: string, kind: string) {
  let b: string;
  if (kind === 'paper') b = ticket({ w: 36, h: 52 });
  else if (kind === 'phone')
    b = phone({ x: 1, w: 34, h: 52, inside: pass({ x: 7, y: 11, w: 22, h: 31, tone: 'violet' }) });
  else if (kind === 'tap') b = tapCard({ w: 36, h: 52 });
  else b = pass({ w: 36, h: 52, tone: 'blue' });
  return g('', g('translate(0 231)', legs(36, 52) + b), `s-q ${k}`);
}
function post(x: number) {
  return p(`M${x} 292v-54`, G, 6) + c(x, 236, 6, G) + p(`M${x - 10} 291h20`, G, 4);
}
function bunting() {
  let o = '',
    cols = [T, G, V, B],
    i: number,
    t: number,
    x: number,
    y: number;
  for (i = 0; i < 9; i++) {
    t = 0.12 + i * 0.095;
    x = (1 - t) * (1 - t) * 8 + 2 * (1 - t) * t * 122 + t * t * 236;
    y = (1 - t) * (1 - t) * 44 + 2 * (1 - t) * t * 96 + t * t * 38;
    o += r((x - 4.5).toFixed(1), (y + 1).toFixed(1), 9, 12, 2, cols[i % 4] as string);
  }
  return p('M8 44Q122 96 236 38', L, 1.4, ' stroke-opacity=".6"') + g('', o, 's-bn');
}
let DOOR: string | null = null;
function door() {
  if (DOOR) return DOOR;
  DOOR =
    f('M236 292V26a20 20 0 0 1 20-20h312a20 20 0 0 1 20 20v266Z', V) +
    c(236, 92, 11, 'var(--ground)', ' style="fill:var(--ground)"') +
    c(588, 92, 11, 'var(--ground)', ' style="fill:var(--ground)"') +
    p('M254 92h316', K, 3, ` stroke-opacity=".5" stroke-dasharray="7 7"${BT}`) +
    g('', p('M268 24h288M268 72h288', G, 8, ' stroke-dasharray="0 48"'), 's-bl') +
    g('', p('M292 24h264M292 72h264', G, 8, ' stroke-dasharray="0 48"'), 's-bl s-b2') +
    p('M290 48h244', '#14063a', 22, ` stroke-dasharray="5 3 2 3 8 2 3 4 2 3 6 3"${BT}`) +
    r(382, 122, 46, 80, 8, T) +
    c(394, 136, 5, K) +
    p('M403 136h17', K, 3) +
    p('M390 154h30M390 164h20', K, 3, ' stroke-opacity=".45"') +
    barcode(390, 186, 30, 14) +
    r(534, 130, 38, 54, 6, O) +
    c(553, 146, 6, K) +
    barcode(542, 170, 22, 10) +
    p('M476 104v10', K, 3) +
    c(476, 121, 7, G) +
    f('M436 292V182a40 40 0 0 1 80 0v110Z', K, sk(6, G)) +
    g('', p('M458 214h36', T, 5, ' stroke-dasharray="0 12"'), 's-dl') +
    g('', p('M452 236h48', O, 5, ' stroke-dasharray="0 12"'), 's-dl s-dl2') +
    p('M8 292V44', '#2a3142', 4) +
    c(8, 40, 6, G) +
    bunting() +
    star(150, 28, 1, O, 's-tw') +
    star(200, 120, 0.6, G, 's-tw s-t2') +
    star(64, 150, 0.55, T, 's-tw s-t3') +
    visitor('s-k1', 'paper') +
    visitor('s-k2', 'blue') +
    visitor('s-k3', 'phone') +
    visitor('s-k4', 'tap') +
    post(24) +
    post(136) +
    p('M24 244q56 24 112 0', O, 5) +
    pedestal({ x: 200, y: 292 }) +
    g('', c(200, 225.5, 13, 'none', sk(1.8, T)), 's-pl') +
    g('', c(200, 225.5, 5.5, OK) + p('M197.4 225.8l1.9 1.9 3.4-3.6', K, 1.6), 's-ck') +
    check(204, 196, 12, 's-ck') +
    buddyAt('translate(226 164.25) scale(1.75)', 'wave', {
      armCls: 's-wv',
      up: 'b-ln',
      faceCls: 's-nd',
    });
  return DOOR;
}

export const DOOR_SCENES: Scenes = {
  door: () => {
    return svg('0 -8 600 300', door(), 'wide') + svg('8 150 470 142', door(), 'narrow');
  },
  /* door-hero: the door with a taller phone crop (queue, pedestal and Buddy fill the band) */
  'door-hero': () => {
    return svg('0 -8 600 300', door(), 'wide') + svg('10 116 420 176', door(), 'narrow');
  },
  /* door-pass: door-hero plus a large readable member pass shown at the pedestal (first-screen hero) */
  'door-pass': () => {
    const shown =
      pass({
        x: 64,
        y: 96,
        w: 120,
        h: 132,
        tone: 'violet',
        edge: 1.4,
        body:
          r(72, 104, 15, 15, 3.5, W, ' fill-opacity=".14"') +
          f('M74 116.5l3.6-6 2.1 3.2 1.2-1.7 2.3 4.5Z', G) +
          tx(92, 115.5, 8.4, W, 'Northside Climbing', ' font-weight="600"') +
          r(64.8, 126, 118.4, 18, 0, '#5b35c8') +
          c(80, 137, 2, G) +
          c(98, 131, 1.4, T) +
          c(120, 139, 2, O) +
          c(150, 133, 1.4, W) +
          c(168, 139, 1.8, G) +
          tx(72, 157, 5, '#cdb9ff', 'MEMBER', ' class="tm"') +
          tx(72, 171, 13, W, 'Alex Morgan', ' font-weight="600"') +
          tx(72, 188, 5, '#cdb9ff', 'PLAN', ' class="tm"') +
          tx(72, 199, 9, W, 'Full') +
          r(134, 178, 42, 42, 4, W) +
          qr(137, 181, 1.71),
      }) +
      f('M150 227h14l-5 6Z', '#2a1668') +
      check(184, 98, 12, 's-ck');
    const art = door().replace(check(204, 196, 12, 's-ck'), '') + shown;
    return svg('0 -8 600 300', art, 'wide') + svg('10 82 420 210', art, 'narrow');
  },
  /* kinds-guide: the Buddy points at four tiles in turn (pair with .kinds-sync) */
  'kinds-guide': () => {
    return svg(POSE_VB, body('point', { armCls: 'b-seq' }));
  },
  /* tap-sync: card and wristband tap the reader; rings and a Buddy wave on each tap */
  'tap-sync': () => {
    const rings =
      g('', p('M200 76a18 18 0 0 1 0 22', K, 2.4), 's-ring2') +
      g('', p('M206 70a26 26 0 0 1 0 34', K, 2.4), 's-ring2 s-r2') +
      g('', p('M212 64a34 34 0 0 1 0 46', K, 2.4), 's-ring2 s-r3');
    return svg(
      '0 0 400 210',
      reader({ x: 180, y: 206 }) +
        rings +
        g('', tapCard({ x: 40, y: 92, w: 92, h: 58 }), 's-tapc') +
        g('', wristband({ x: 268, y: 170, s: 1.3 }), 's-tapw') +
        buddyAt('translate(262 46) scale(1.5)', 'wave', { armCls: 'b-wavetap' }),
    );
  },
};
