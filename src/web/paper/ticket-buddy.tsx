import {
  BUDDY_LINE,
  BUDDY_MM,
  BUDDY_PATHS,
  BUDDY_POSES,
  BUDDY_RATIO,
  BUDDY_VIEWBOX,
  type BuddyPose,
  buddyPalette,
} from '../../shared/paper-buddy.ts';

const W = BUDDY_LINE;

/** The buddy, static and decorative: no alt text, no motion. `mono` is the line version. */
export function TicketBuddy({
  pose,
  mono,
  mm = BUDDY_MM.default,
}: {
  pose: BuddyPose;
  mono: boolean;
  mm?: number;
}) {
  const c = buddyPalette(mono);
  const p = BUDDY_POSES[pose];
  const P = BUDDY_PATHS;
  const mark = {
    fill: 'none',
    stroke: c.mark,
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
  };
  const card = (fill: string, transform: string, children?: React.ReactNode) => (
    <g transform={transform}>
      <path d={P.card} fill={fill} stroke={c.line} strokeWidth={W} />
      <path d={P.highlight} stroke={c.highlight} strokeWidth={W} />
      {children}
    </g>
  );
  const top =
    pose === 'coupon' ? (
      <g {...mark}>
        <path d={P.percent[0]} />
        <circle cx="44.5" cy="18.5" r="2.2" />
        <circle cx="51.5" cy="27.5" r="2.2" />
      </g>
    ) : pose === 'ready' ? (
      <path d={P.check} {...mark} strokeWidth={2.6} strokeLinejoin="round" />
    ) : null;
  return (
    <svg
      className="pp-buddy"
      viewBox={BUDDY_VIEWBOX}
      style={{
        width: `calc(var(--mm) * ${mm})`,
        height: `calc(var(--mm) * ${(mm * BUDDY_RATIO).toFixed(2)})`,
      }}
      aria-hidden="true"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={P.legLeft} fill={c.body} stroke={c.line} strokeWidth={W} />
      <path d={P.legRight} fill={c.body} stroke={c.line} strokeWidth={W} />
      {card(c.passes[0], p.wave ? 'rotate(-52 48 64)' : 'rotate(-18 48 64)')}
      {card(c.passes[2], 'rotate(18 48 64)')}
      {card(c.passes[1], p.lift ? `translate(0 -${p.lift})` : '', top)}
      <rect
        x="16"
        y="30"
        width="64"
        height="36"
        rx="9"
        fill={c.body}
        stroke={c.line}
        strokeWidth={W}
      />
      <rect
        x="20"
        y="34"
        width="56"
        height="28"
        rx="6"
        fill="none"
        stroke={c.line}
        strokeWidth={W * 0.8}
        strokeDasharray="2 2.5"
        opacity=".7"
      />
      <rect
        x="36"
        y="37"
        width="24"
        height="16"
        rx="7"
        fill={c.screenFill}
        stroke={c.screen}
        strokeWidth={W}
      />
      <g transform={p.wave ? 'translate(-1.6 -1.4)' : undefined}>
        {p.joy ? (
          <path d={P.joy} fill="none" stroke={c.face} strokeWidth={W} strokeLinecap="round" />
        ) : (
          <>
            <ellipse cx="43.5" cy="43.5" rx="1.7" ry="2.1" fill={c.face} />
            <ellipse cx="52.5" cy="43.5" rx="1.7" ry="2.1" fill={c.face} />
          </>
        )}
      </g>
      <path
        d={p.bigSmile ? P.bigSmile : P.smile}
        fill="none"
        stroke={c.face}
        strokeWidth={W}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Which pose a class holds; none for the permit (the dashboard face is the council's) and the card. */
export function buddyPose(kind: string, noun: string): BuddyPose | null {
  if (kind === 'admission') return noun === 'pass' ? 'happy' : 'wave';
  if (kind === 'membership') return 'happy';
  if (kind === 'coupon') return 'coupon';
  if (kind === 'pickup') return 'ready';
  return null;
}
