import { arm, buddyAt, FACES, LEGS, POCKET, SHADOW } from './body.ts';
import { clock, pass, pedestal, phone, reader, tapCard, ticket, wristband } from './parts.ts';
import {
  c,
  check,
  f,
  G,
  g,
  K,
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

export const STOP_SCENES: Scenes = {
  design: () => {
    return svg(
      '0 0 200 150',
      p('M32 112l-10 38M84 112l10 38M58 112v38', K, 4) +
        r(14, 10, 88, 104, 5, W, sk(2, K)) +
        '<rect x="29.5" y="19.5" width="57" height="85" rx="4"' +
        sk(1.2, '#7e8699') +
        ' stroke-dasharray="3 3"/>' +
        g('', pass({ x: 30, y: 20, w: 56, h: 84, tone: 'navy', body: '' }), 's-dr') +
        g(
          '',
          r(35, 25, 10, 10, 2.4, G) + p('M49 28h30', W, 2.4) + p('M49 33h18', '#9fb6e0', 1.6),
          's-dr s-d1',
        ) +
        g(
          '',
          r(30.5, 40, 55, 13, 0, '#21508f') +
            c(40, 46, 1.6, G) +
            c(52, 44, 1.2, T) +
            c(64, 48, 1.6, O) +
            c(76, 45, 1.2, W),
          's-dr s-d2',
        ) +
        g('', p('M35 62h34', W, 3.4) + p('M35 69h14M54 69h14', '#9fb6e0', 1.6), 's-dr s-d3') +
        g('', r(46, 77, 24, 22, 2, W) + qr(48.5, 78.5, 0.9), 's-dr s-d4') +
        star(114, 28, 0.6, G, 's-tw') +
        star(104, 92, 0.45, W, 's-tw s-t2') +
        buddyAt('translate(92 66) scale(1.15)', 'point', {}),
    );
  },
  send: () => {
    return svg(
      '0 0 200 150',
      g(
        '',
        phone({ x: 14, y: 34, w: 50, h: 100 }) +
          g('', pass({ x: 24, y: 58, w: 30, h: 42 }), 's-lp'),
        's-pb',
      ) +
        p('M150 96Q104 -24 44 70', K, 1.8, ' stroke-dasharray=".01 5" stroke-opacity=".4"') +
        r(138, 16, 44, 28, 4, W, sk(1.8, K)) +
        g('', f('M139 17l21 14 21-14Z', '#e3e8f6', sk(1.4, K)), 's-fl') +
        g(
          'translate(100 66) scale(1.15)',
          SHADOW +
            LEGS +
            g(
              '',
              arm(T, 'rotate(-32 48 64)', 'b-fk') +
                arm(G, 'rotate(32 48 64)') +
                POCKET +
                FACES.happy,
              'b-breathe',
            ),
        ) +
        g(
          '',
          g(
            '',
            g('translate(96 26)', g('', pass({ x: -12, y: -17, w: 24, h: 34 }), 's-sr')),
            's-sy',
          ),
          's-sx',
        ),
    );
  },
  update: () => {
    return svg(
      '0 0 200 150',
      '<defs><clipPath id="pb-c-update"><rect x="20" y="32" width="46" height="86" rx="4"/></clipPath></defs>' +
        phone({ x: 10, y: 16, w: 66, h: 128 }) +
        pass({ x: 20, y: 32, w: 46, h: 86, tone: 'teal', body: '' }) +
        r(24, 36, 8, 8, 2, W, ' fill-opacity=".14"') +
        f('M25.3 42.4l1.9-3.2 1.1 1.7.6-.9 1.2 2.4Z', G) +
        tx(35, 42, 5.4, W, 'Northside', ' font-weight="600"') +
        tx(24, 56, 3.4, '#9fd8d0', 'NEXT CLASS', ' class="tm"') +
        g('', tx(24, 67, 7.4, W, 'Thu 19:00', ' font-weight="600"'), 's-vo') +
        g('', tx(24, 67, 7.4, W, 'Thu 18:30', ' font-weight="600"'), 's-vn') +
        tx(24, 79, 3.4, '#9fd8d0', 'ROOM', ' class="tm"') +
        tx(24, 86, 4.6, W, 'Lead wall') +
        r(31, 93, 24, 21, 2, W) +
        qr(33, 94.5, 0.86) +
        '<g clip-path="url(#pb-c-update)">' +
        g('', f('M22 28h12l-12 96H10Z', 'url(#pb-band)'), 's-swp') +
        '</g>' +
        clock({ x: 174, y: 50, r: 18 }) +
        buddyAt('translate(88 66) scale(1.15)', 'happy', { up: '' }).replace(
          arm(G, 'rotate(18 48 64)'),
          arm(G, 'rotate(26 48 64)', 's-tp'),
        ),
    );
  },
  scan: () => {
    return svg(
      '0 0 200 150',
      reader({ x: 23, y: 150 }) +
        g('', c(23, 75, 8, 'none', sk(1.6, T)), 's-pl2') +
        g('', c(23, 75, 5, OK) + p('M20.6 75.2l1.7 1.7 3-3.2', K, 1.5), 's-ck4') +
        g('', g('translate(160 101)', legs(28, 40, K) + pass({ w: 28, h: 40 })), 's-wk') +
        buddyAt('translate(56 66) scale(1.15)', 'wave', { armCls: 's-w4' }),
    );
  },

  'kind-wallet': () => {
    return svg(
      '0 0 160 120',
      phone({ x: 51, y: 8, w: 58, h: 118 }) +
        r(60, 24, 40, 16, 3, G) +
        r(60, 32, 40, 16, 3, V) +
        r(60, 40, 40, 16, 3, O) +
        g('', pass({ x: 60, y: 48, w: 40, h: 58, tone: 'blue' }), 's-kj'),
    );
  },
  'kind-paper': () => {
    return svg(
      '0 0 160 120',
      g('rotate(-6 80 66)', ticket({ x: 14, y: 40, w: 132, h: 58, ground: G })) +
        star(140, 20, 0.6, W, 's-tw'),
    );
  },
  'kind-mobile': () => {
    return svg(
      '0 0 160 120',
      phone({ x: 50, y: 8, w: 60, h: 118, screen: '#e9edf8' }) +
        r(58, 18, 44, 7, 3.5, '#c9cfdf') +
        c(63, 21.5, 1.6, '#7e8699') +
        pass({ x: 60, y: 32, w: 40, h: 60 }),
    );
  },
  'kind-tap': () => {
    return svg(
      '0 0 160 120',
      tapCard({ x: 20, y: 42, w: 62, h: 40 }) +
        g('', p('M88 48a14 14 0 0 1 0 28M95 42a22 22 0 0 1 0 40', K, 2.4), 's-kp') +
        wristband({ x: 124, y: 80 }),
    );
  },

  'ans-yes': () => {
    return svg(
      '0 0 200 150',
      pedestal({ x: 30, y: 148 }) +
        check(30, 50, 10, 's-ck1') +
        buddyAt('translate(62 54) scale(1.3)', 'wave', { face: 'happy' }),
    );
  },
  'ans-already': () => {
    return svg('0 0 200 150', buddyAt('translate(22 57) scale(1.25)', 'clock', {}));
  },
  'ans-no': () => {
    return svg(
      '0 0 200 150',
      reader({ x: 30, y: 148 }) +
        g('', c(30, 73, 7, O) + p('M27 70l6 6M33 70l-6 6', W, 1.8), 's-ck1') +
        buddyAt('translate(60 54) scale(1.3)', 'shake', {}),
    );
  },
  'ans-sorry': () => {
    return svg('0 0 200 150', buddyAt('translate(16 57) scale(1.25)', 'sorry', {}));
  },

  tap: () => {
    const rings =
      g('', p('M200 76a18 18 0 0 1 0 22', K, 2.4), 's-ring') +
      g('', p('M206 70a26 26 0 0 1 0 34', K, 2.4), 's-ring s-r2') +
      g('', p('M212 64a34 34 0 0 1 0 46', K, 2.4), 's-ring s-r3');
    return svg(
      '0 0 400 210',
      reader({ x: 180, y: 206 }) +
        rings +
        g('', tapCard({ x: 40, y: 92, w: 92, h: 58 }), 's-tapc') +
        g('', wristband({ x: 268, y: 170, s: 1.3 }), 's-tapw') +
        buddyAt('translate(262 46) scale(1.5)', 'wave', {}),
    );
  },
};
