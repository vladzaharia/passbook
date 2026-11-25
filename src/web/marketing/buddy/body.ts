import { clock, pass, plug } from './parts.ts';
import { el, f, G, g, P, p, r, S, sk, star, svg, T, V, W } from './svg.ts';

function wl(d: string) {
  return p(d, W, 1.2);
}
const AR = 'M41.8 44.4q1.7-2.4 3.4 0M50.8 44.4q1.7-2.4 3.4 0',
  EY = el(43.5, 43.5, 1.7, 2.1) + el(52.5, 43.5, 1.7, 2.1);
export const FACES = {
  rest: EY + wl('M45.5 47.5q2.5 2 5 0'),
  happy: wl(AR) + wl('M45 47.3q3 2.6 6 0'),
  delight: wl(AR) + f('M45.2 47h5.6q-.3 3.6-2.8 3.6t-2.8-3.6z', W),
  focus:
    el(41.9, 44, 1.7, 1.6) +
    el(50.9, 44, 1.7, 1.6) +
    wl('M40.3 40.6q1.5-1 3 0M49.3 40.6q1.5-1 3 0M44.2 47.8q2 1.8 4 0'),
  curious:
    g('translate(.8 -.8)', EY) +
    wl('M41.8 39.6l2.8-.4M51.6 37.8l3 .9') +
    wl('M47.1 48.6a.9 1 0 1 0 1.8 0a.9 1 0 1 0-1.8 0'),
  sad: EY + wl('M41.3 41l3.3-1.5M51.4 39.5l3.3 1.5M45.7 49.6q2.3-1.9 4.6 0'),
  no: wl('M41.8 43.6h3.4M50.8 43.6h3.4M41.2 40.6l3.2 1M54.8 40.6l-3.2 1M45.6 48.6h4.8'),
  sleep: `${wl('M41.6 43.4q1.9 1.7 3.8 0M50.6 43.4q1.9 1.7 3.8 0')}<ellipse cx="48" cy="48.6" rx="1.1" ry="1"${sk(1.1, W)}/>`,
  sorry: EY + wl('M41.2 39.6q1.6-1.6 3.4-.6M51.4 39q1.8-1 3.4.6M45.4 48.6q1.3-1 2.6 0t2.6 0'),
  wink:
    wl('M41.8 44.4q1.7-2.4 3.4 0') +
    el(52.5, 43.3, 1.7, 2.1, 'b-wk') +
    wl('M50.6 39.8l3.4-.6M44.8 47.4q3.2 2.8 6.4-.4'),
  up: el(43.5, 42.2, 1.7, 2.1) + el(52.5, 42.2, 1.7, 2.1) + el(48, 48.8, 1.3, 1.5),
};
export const SHADOW = '<ellipse cx="48" cy="66.6" rx="34" ry="3" fill="url(#pb-shadow)"/>';
export const LEGS =
  f('M35 60h5v10.5a2.5 2.5 0 0 1-2.5 2.5h-3a2 2 0 0 1 0-4h.5Z', P, sk(1, S)) +
  f('M56 60h5v9h.5a2 2 0 0 1 0 4h-3a2.5 2.5 0 0 1-2.5-2.5Z', P, sk(1, S));
export const POCKET =
  r(16, 30, 64, 36, 9, 'url(#pb-pk)', sk(1, S)) +
  p('M25 31.4h46', W, 0.8, ' stroke-opacity=".1"') +
  '<rect x="20" y="34" width="56" height="28" rx="6"' +
  sk(0.9, S) +
  ' stroke-dasharray="1.6 1.8" opacity=".75"/>' +
  r(36, 37, 24, 16, 7, 'url(#pb-cl)', sk(1, T)) +
  p('M40.5 39.2h5', W, 0.9, ' stroke-opacity=".22"');
/* a pass-arm: fill, transform about the pocket, optional class for its act */
export function arm(fl: string, t: string, cl?: string) {
  return g(
    t,
    g('', r(37, 9, 22, 31, 3, fl, sk(1, S)) + p('M41 14h9', W, 1, ' stroke-opacity=".55"'), cl),
  );
}
const ARCS = 'M8-6q-6 6-3 14M1-12q-10 8-7 22';
export const POSES = [
  'rest',
  'happy',
  'curious',
  'focus',
  'wave',
  'point',
  'clap',
  'cheer',
  'peek',
  'wink',
  'sleep',
  'shake',
  'sorry',
  'tuck',
  'offer',
  'clock',
];

/* body(name, o) Buddy markup in its own 96x72 space. o.face overrides the face, o.dir ('left'|'right') for point,
   o.up / o.faceCls / o.armCls swap the act classes (scenes use these to sync to their beat). */
const faceOf = (name: string): string | undefined => (FACES as Record<string, string>)[name];

/** face: a name from FACES, or raw face markup; dir: which way point goes; up/faceCls/armCls sync a scene's act classes. */
export type BodyOpts = {
  face?: string;
  dir?: string;
  label?: string;
  up?: string;
  faceCls?: string;
  armCls?: string;
  back?: string;
  shadow?: boolean;
};

export function body(name: string, o: BodyOpts = {}) {
  let face = o.face,
    a1 = arm(T, 'rotate(-18 48 64)'),
    a3 = arm(G, 'rotate(18 48 64)'),
    a2 = arm(V, ''),
    arms: string | null = null,
    front = '',
    after = '',
    up = o.up,
    fcl = o.faceCls || '';
  switch (name) {
    case 'happy':
      face = face || 'happy';
      break;
    case 'curious':
      face = face || 'curious';
      arms = g('rotate(7 48 64)', a1 + a3 + a2);
      break;
    case 'focus':
      face = face || 'focus';
      break;
    case 'wave':
      face = face || 'happy';
      a1 = arm(T, 'translate(-16 -8) rotate(-14 48 64)', o.armCls || 'b-wave');
      front = g('', p(ARCS, 'currentColor', 1.3, ' stroke-opacity=".6"'), 'b-arcs');
      break;
    case 'point':
      face = face || 'focus';
      if (o.dir === 'right') {
        a3 = arm(G, 'rotate(82 48 64)', 'b-pj b-pjr');
        after = star(110, 54, 0.6, 'currentColor', 'b-tw');
      } else {
        a1 = arm(T, 'rotate(-82 48 64)', o.armCls || 'b-pj');
        after = star(-15, 52, 0.6, 'currentColor', 'b-tw');
      }
      break;
    case 'clap':
      face = face || 'delight';
      a1 = arm(T, 'rotate(8 48 64)', 'b-c1');
      a3 = arm(G, 'rotate(-8 48 64)', 'b-c3');
      a2 = '';
      front = g('', p('M48-6v-6M39-3l-4-4M57-3l4-4', 'currentColor', 1.4), 'b-burst');
      break;
    case 'cheer':
      face = face || 'delight';
      up = up === undefined ? 'b-bob' : up;
      a1 = arm(T, 'translate(-6 -12) rotate(-38 48 64)');
      a3 = arm(G, 'translate(6 -12) rotate(38 48 64)');
      a2 = arm(V, 'translate(0 -14)');
      after = star(-12, 6, 0.55, G, 'b-tw') + star(108, 2, 0.55, T, 'b-tw s-t2');
      break;
    case 'peek':
      face = face || 'rest';
      up = up === undefined ? 'b-peek' : up;
      after = pass({
        x: 18,
        y: 45,
        w: 60,
        h: 29,
        tone: 'violet',
        body:
          r(23, 50, 8, 8, 2, G) +
          p('M35 53h22', W, 2) +
          p('M23 64h18', W, 2.6) +
          r(58, 58, 14, 11, 1.5, W),
      });
      break;
    case 'wink':
      face = face || 'wink';
      a3 = arm(G, 'rotate(42 48 64)');
      a2 = arm(V, 'rotate(2 48 64)');
      after = star(92, 12, 0.55, 'currentColor', 'b-tw');
      break;
    case 'sleep':
      face = face || 'sleep';
      up = up === undefined ? 'b-snore' : up;
      arms = g(
        'translate(0 14)',
        arm(T, 'rotate(-22 48 64)') + arm(G, 'rotate(22 48 64)') + arm(V, ''),
      );
      after = g('', p('M70 18h4l-4 4.5h4M78 8h5.5l-5.5 6h5.5', 'currentColor', 1.2), 'b-zz');
      break;
    case 'shake':
      face = face || 'no';
      up = up === undefined ? 'b-shake' : up;
      arms =
        arm(T, 'translate(0 3) rotate(-30 48 64)') +
        arm(G, 'translate(0 3) rotate(30 48 64)') +
        arm(V, 'translate(0 5)');
      break;
    case 'sorry':
      face = face || 'sorry';
      arms =
        arm(T, 'translate(0 3) rotate(-26 48 64)') +
        arm(G, 'translate(0 3) rotate(26 48 64)') +
        arm(V, 'translate(0 4)');
      after = plug({ x: 100, y: 58 });
      break;
    case 'tuck':
      face = face || 'happy';
      a1 = arm(T, 'rotate(-26 48 64)');
      a3 = arm(G, 'rotate(26 48 64)');
      a2 = g('', pass({ x: 36, y: -8, w: 24, h: 34, tone: 'violet' }), 'b-tuck');
      break;
    case 'offer':
      face = face || 'up';
      a1 = arm(T, 'rotate(-30 48 64)');
      a3 = arm(G, 'rotate(30 48 64)');
      a2 = g('', pass({ x: 33, y: -18, w: 30, h: 44, tone: 'violet' }), 'b-offer');
      break;
    case 'clock':
      face = face || 'focus';
      a3 = arm(G, 'rotate(66 48 64)', 'b-pj b-pjr');
      after = clock({ x: 112, y: 20, r: 13, spin: 'b-hand' });
      break;
    default:
      face = face || 'rest';
  }
  if (up === undefined) up = 'b-breathe';
  const faceMarkup = faceOf(face ?? '') || face;
  return (
    (o.shadow === false ? '' : SHADOW) +
    (o.back || '') +
    LEGS +
    g('', (arms || a1 + a3 + a2) + POCKET + g('', faceMarkup, fcl) + front, up) +
    after
  );
}
export function buddyAt(t: string, name: string, o: BodyOpts) {
  return g(t, body(name, o));
}
export const POSE_VB = '-38 -28 176 106';
/* draw(pose, {face, dir, label}): face must be a name from FACES */
export function draw(name: string, o: BodyOpts = {}) {
  if (POSES.indexOf(name) < 0) name = 'rest';
  const safe = {
    dir: o.dir === 'right' ? 'right' : 'left',
    label: o.label,
    face: o.face && faceOf(o.face) ? o.face : undefined,
  };
  return svg(POSE_VB, body(name, safe), `buddy b-pose-${name}`, safe.label);
}
