/**
 * Scan props (src/web/scan/buddy/props.tsx), drawn in the wallet art's units and passed through
 * the buddy's slots: onCard rides with the violet pass, front draws over the pocket, aside stands
 * on the surface at its left. One beat's props at a time; each set is 1 to 4 nodes, so the seated
 * buddy (30 nodes) stays under the 40-node rule. No text. Red refusals have no prop: they shake.
 */
import type { ReactNode } from 'react';

export interface ScanParts {
  onCard?: ReactNode;
  front?: ReactNode;
  aside?: ReactNode;
}

/** punch: a hole in the violet pass, and the chad that falls out of it. */
const PUNCH = (
  <>
    <circle data-k="hole" className="s" cx="52.5" cy="14" r="1.9" />
    <circle data-k="chad" className="c2" cx="52.5" cy="14" r="1.9" />
  </>
);

/** stamp: an ink ring with a star, centred low on the violet pass. */
const STAMP = (
  <g data-k="stamp">
    <circle className="m" cx="48" cy="27" r="4.4" />
    <path className="m" d="M48 24.4l.8 1.7 1.8.2-1.3 1.2.4 1.8-1.7-.9-1.7.9.4-1.8-1.3-1.2 1.8-.2Z" />
  </g>
);

/** sparkle: three foil sparks over the fan; data-i staggers them. */
const SPARK = 'm0-3.4 1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1Z';
const SPARKS = (
  <>
    {(
      [
        [41, 5, 1],
        [48, 2, 2],
        [55, 5, 3],
      ] as const
    ).map(([x, y, n], i) => (
      <path key={n} data-k="sp" data-i={i} className={`c${n}`} stroke="none" d={`M${x} ${y}${SPARK}`} />
    ))}
  </>
);

/** wrist and stash: a small clock on the surface at its left, the minute hand on its own. */
const CLOCK = (
  <g data-k="clock">
    <circle className="o" cx="9" cy="59.5" r="6" />
    <path className="m" d="M9 59.5h2.6" />
    <path data-k="hand" className="m" d="M9 59.5V55.6" />
  </g>
);

/** cloud: on the surface at its left, like the clock (no connection, matching the CloudOff icon). Over
 * the head it would cover the B card's bottom edge. */
const CLOUD = <path data-k="cloud" className="o" d="M6 66h12a4 4 0 0 0 .5-8a6 6 0 0 0-11.4-1.6A4.6 4.6 0 0 0 6 66Z" />;

/** note: a notepad held low over the pocket; the eyes follow the caret (pose note). */
const NOTEPAD = (
  <g data-k="pad">
    <rect className="o" x="39" y="53" width="18" height="12.5" rx="1.5" />
    <path className="m" d="M42 57.5h12M42 61h8M42 53v-1.6M46 53v-1.6M50 53v-1.6M54 53v-1.6" />
  </g>
);

/** rings: two arcs from the pocket toward the reader side (once on entry). */
const RINGS = (
  <>
    <path data-k="ring" data-i="0" className="m" d="M82 41a9 9 0 0 1 0 12" />
    <path data-k="ring" data-i="1" className="m" d="M86.5 37.5a14 14 0 0 1 0 19" />
  </>
);

/** sleep: the eyes shut (pose sleep fades them in over the open eyes). */
const ZZ = <path data-k="zz" className="m" d="M41.8 43.6q1.7 1.3 3.4 0M50.8 43.6q1.7 1.3 3.4 0" />;

/** cover: two small passes rise in front of the eyes (the fan's outer two dip behind the pocket). */
const PAWS = (
  <>
    <rect data-k="paw" data-i="0" className="c1" x="38.5" y="38.5" width="9" height="11" rx="2" />
    <rect data-k="paw" data-i="1" className="c3" x="48.5" y="38.5" width="9" height="11" rx="2" />
  </>
);

export const SCAN_PARTS = {
  punch: { onCard: PUNCH },
  stamp: { onCard: STAMP },
  sparkle: { front: SPARKS },
  wrist: { aside: CLOCK },
  stash: { aside: CLOCK },
  cloud: { aside: CLOUD },
  note: { front: NOTEPAD },
  rings: { front: RINGS },
  sleep: { front: ZZ },
  cover: { front: PAWS },
} satisfies Record<string, ScanParts>;
