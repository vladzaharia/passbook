import { arm, body, buddyAt, FACES, LEGS, POCKET, SHADOW } from './body.ts';
import { pass, ticket } from './parts.ts';
import {
  BT,
  c,
  f,
  G,
  g,
  K,
  legs,
  O,
  OK,
  P,
  p,
  r,
  S,
  type Scenes,
  sk,
  star,
  star5,
  svg,
  T,
  tx,
  V,
  W,
} from './svg.ts';

export const JOB_SCENES: Scenes = {
  'job-checkin': () => {
    return svg(
      '0 0 200 150',
      p('M58 30h84', K, 6) +
        r(44, 14, 14, 32, 4, K) +
        r(142, 14, 14, 32, 4, K) +
        r(36, 20, 8, 20, 3, K) +
        r(156, 20, 8, 20, 3, K) +
        r(112, 96, 88, 54, 0, K) +
        r(104, 90, 96, 9, 3, W, sk(2, K)) +
        p('M152 90v-10', K, 5) +
        r(134, 52, 36, 28, 5, W, sk(2, K)) +
        g('', c(152, 66, 8, OK) + p('M148 66l3 3 5-6', K, 2.2), 's-c2') +
        g(
          '',
          g('translate(42 87)', legs(40, 54, K) + pass({ w: 40, h: 54 }) + r(0, 13, 40, 6, 0, O)),
          's-w2',
        ),
    );
  },
  'job-tickets': () => {
    return svg(
      '0 0 200 150',
      g('', f('M14 0h34l62 150H56Z', W, ' fill-opacity=".2"'), 's-spot') +
        g('', f('M186 0h-34L90 150h54Z', W, ' fill-opacity=".2"'), 's-spot s-t2') +
        p('M34 52V30l14-4v22', K, 3) +
        '<ellipse cx="30.5" cy="52" rx="4.5" ry="3.6" fill="' +
        K +
        '"/><ellipse cx="44.5" cy="48" rx="4.5" ry="3.6" fill="' +
        K +
        '"/>' +
        p('M166 74V52q8 2 9 10', K, 3) +
        '<ellipse cx="162.5" cy="74" rx="4.5" ry="3.6" fill="' +
        K +
        '"/>' +
        g(
          '',
          g('translate(80 72)', legs(40, 69, K) + ticket({ w: 40, h: 69, ground: V })),
          'b-dance',
        ),
    );
  },
  'job-stamp': () => {
    return svg(
      '0 0 200 150',
      r(0, 128, 200, 22, 0, K) +
        pass({ x: 10, y: 92, w: 100, h: 36, tone: 'teal', body: '' }) +
        star5(26, 110, W) +
        star5(48, 110, W) +
        star5(70, 110, W) +
        '<circle cx="92" cy="110" r="8"' +
        sk(1.4, W) +
        ' stroke-opacity=".6" stroke-dasharray="2.5 2.5"/>' +
        g('', star5(92, 110, G), 's-nw') +
        g(
          '',
          c(92, 62, 6.5, O, sk(1.8, K)) +
            r(89, 68, 6, 10, 0, K) +
            r(78, 78, 28, 10, 3, K) +
            r(80, 88, 24, 3, 1, G),
          's-sp',
        ) +
        buddyAt('translate(114 61) scale(.92)', 'clap', {}),
    );
  },
  'job-visitors': () => {
    return svg(
      '0 0 200 150',
      r(14, 120, 28, 30, 4, K) +
        f('M28 120c-12-10-10-26 0-32c10 6 12 22 0 32Z', G) +
        f('M152 146a16 16 0 0 1 32 0Z', G, sk(2, K)) +
        p('M146 147h44', K, 4) +
        c(168, 127, 3, K) +
        g(
          '',
          p('M62 0l32 60M138 0l-32 60', K, 5) +
            r(93, 56, 14, 12, 3, '#dbe4ff', sk(2, K)) +
            r(70, 64, 60, 80, 8, W, sk(2, K)) +
            r(71, 65, 58, 16, 7, V) +
            r(71, 73, 58, 8, 0, V) +
            c(100, 102, 11, O) +
            p('M84 124h32M90 133h20', K, 3, ' stroke-opacity=".45"'),
          's-ly',
        ),
    );
  },
  'job-parking': () => {
    return svg(
      '0 0 200 150',
      p('M0 138h200', G, 4, ` stroke-dasharray="20 10"${BT}`) +
        r(174, 86, 9, 46, 2, '#dbe4ff') +
        g(
          '',
          p('M178 92L152 40', O, 7, BT) + p('M178 92L152 40', W, 7, ` stroke-dasharray="7 7"${BT}`),
          's-bar',
        ) +
        g(
          '',
          f(
            'M16 120V104q0-7 7-8l25-4 16-18q4-4 10-4h36q6 0 10 5l14 17 10 2q8 2 8 10v14Z',
            T,
            sk(2, K),
          ) +
            f('M66 90l10-13h16v13ZM98 77h14q4 0 6 3l8 10H98Z', P) +
            pass({ x: 106, y: 79, w: 14, h: 10, tone: 'blue', body: '' }) +
            c(46, 121, 12, K, sk(4, S)) +
            c(124, 121, 12, K, sk(4, S)) +
            c(147, 104, 3, G),
          's-car',
        ) +
        star(140, 58, 0.55, G, 's-tw'),
    );
  },
  'job-classes': () => {
    let dots = '',
      i: number;
    for (i = 0; i < 10; i++)
      dots += c(62 + i * 8.4, 124, 2.8, i < 7 ? W : 'none', i < 7 ? '' : sk(1.2, '#9fd8d0'));
    return svg(
      '0 0 200 150',
      pass({ x: 50, y: 10, w: 100, h: 128, tone: 'teal', body: '' }) +
        r(57, 17, 12, 12, 3, W, ' fill-opacity=".14"') +
        f('M59 27l2.9-4.8 1.7 2.5 1-1.3 1.8 3.6Z', G) +
        tx(74, 26.5, 8, W, 'Northside', ' font-weight="600"') +
        tx(57, 48, 5, '#9fd8d0', 'CLASSES LEFT', ' class="tm"') +
        g('', tx(57, 92, 40, W, '8', ' font-weight="700"'), 's-n8') +
        g('', tx(57, 92, 40, W, '7', ' font-weight="700"'), 's-n7') +
        tx(98, 70, 5, '#9fd8d0', 'PACK OF 10', ' class="tm"') +
        tx(98, 82, 7, W, 'Climbing') +
        dots +
        star(166, 24, 0.7, W, 's-tw'),
    );
  },

  dev: () => {
    return svg(
      '0 0 200 150',
      g('', pass({ x: 18, y: 34, w: 48, h: 70 }), 's-pop') +
        star(14, 30, 0.6, G, 's-tw') +
        star(72, 26, 0.5, T, 's-tw s-t2') +
        buddyAt('translate(92 66) scale(1.15)', 'focus', {}),
    );
  },
  close: () => {
    let sparks = '',
      pts: [number, number, string][] = [
        [-40, -8, T],
        [-22, -30, V],
        [8, -38, G],
        [92, -36, O],
        [122, -14, T],
        [140, 14, G],
      ];
    for (const [n, [px, py, col]] of pts.entries())
      sparks += `<g class="s-spark" style="--i:${n}">${star(px, py, 0.9, col)}</g>`;
    const b = body('wave', {
      armCls: 'b-wave2',
      face: g('', FACES.happy, 'b-f1') + g('', FACES.wink, 'b-f2'),
      up: '',
    });
    return svg('-60 -46 220 124', sparks + b);
  },
  verdict: () => {
    const up = arm(T, 'rotate(-22 48 64)') + arm(G, 'rotate(22 48 64)') + arm(V, ''),
      down =
        arm(T, 'translate(0 3) rotate(-30 48 64)') +
        arm(G, 'translate(0 3) rotate(30 48 64)') +
        arm(V, 'translate(0 5)');
    return svg(
      '0 -6 96 80',
      g(
        '',
        SHADOW +
          LEGS +
          g('', up, 'b-glad') +
          g('', down, 'b-sad') +
          POCKET +
          g('', FACES.happy, 'b-glad') +
          g('', FACES.no, 'b-sad'),
        'b-react',
      ),
    );
  },
};
