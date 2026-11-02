import type { ReactNode } from 'react';
import { Art, type ArtProps, useFoilId } from './base.tsx';

export type WalletState =
  | 'login'
  | 'empty'
  | 'lost'
  | 'confirm'
  | 'expired'
  | 'no-access'
  | 'break-glass';

/**
 * happy: eyes smile shut. flat: half-shut eyes, straight mouth. sad: worried brows, frown, a
 * slump and drooping passes, one sigh as it lands. curious: one brow up, eyes up and aside.
 */
export type WalletMood = 'happy' | 'flat' | 'sad' | 'curious';

export interface WalletArtProps extends ArtProps {
  state?: WalletState;
  mood?: WalletMood;
  /** Top card lifts 6 px. */
  lift?: boolean;
  /**
   * Sits on the surface below: the base on y 66 of 72, paws over the edge and a contact shadow.
   * The host overlaps the surface by 1/12 of the art's height and stacks the art above it.
   */
  seat?: boolean;
  /** Drawn on the top card, in the eye group and in front (sign-in and auth page extras). */
  onCard?: ReactNode;
  face?: ReactNode;
  front?: ReactNode;
}

const CARD = 'M40 9h16a3 3 0 0 1 3 3v25a3 3 0 0 1-3 3H40a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3Z';
const SMILE = 'M45.5 47.5q2.5 2 5 0';
const MOUTH: Partial<Record<WalletMood, string>> = {
  sad: 'M45.7 49.6q2.3-1.9 4.6 0',
  flat: 'M45.9 48.6h4.2',
  curious: 'M47.1 48.6a.9 1 0 1 0 1.8 0a.9 1 0 1 0-1.8 0',
};
const BROWS: Partial<Record<WalletMood, string>> = {
  sad: 'M41.3 41l3.3-1.5M51.4 39.5l3.3 1.5',
  curious: 'M41.8 39.6l2.8-.4M51.6 37.8l3 .9',
};
/** Legs hang over the surface's edge, feet turned out. */
const LEG_L = 'M35 60h5v10.5a2.5 2.5 0 0 1-2.5 2.5h-3a2 2 0 0 1 0-4h.5Z';
const LEG_R = 'M56 60h5v9h.5a2 2 0 0 1 0 4h-3a2.5 2.5 0 0 1-2.5-2.5Z';
const JOY = 'M41.8 44.4q1.7-2.4 3.4 0M50.8 44.4q1.7-2.4 3.4 0';

const card = (n: 1 | 2 | 3, extra?: string, children?: ReactNode) => (
  <g data-part={`c${n}`} data-i={n - 1} className={extra}>
    <path className={`c${n}`} d={CARD} />
    <path className="hl" d="M41 14h9" />
    {children}
  </g>
);

/** The holder mascot. SSR-safe: no inline styles; pages inline ART_CSS (css.ts). */
export function WalletArt({
  state = 'empty',
  mood,
  lift,
  seat,
  onCard,
  face,
  front,
  ...props
}: WalletArtProps) {
  const shade = useFoilId();
  const cards = state !== 'empty' && state !== 'lost';
  const brows = mood ? BROWS[mood] : undefined;
  return (
    <Art name="wallet" state={state} {...props}>
      {seat ? (
        <>
          <defs>
            <radialGradient id={shade}>
              <stop className="sd" offset=".4" />
              <stop className="sd" offset="1" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse data-part="sd" fill={`url(#${shade})`} cx="48" cy="68" rx="34" ry="3.2" />
        </>
      ) : null}
      <g
        data-part="w"
        data-b=""
        data-mood={mood}
        data-lift={lift ? '' : undefined}
        data-seat={seat ? '' : undefined}
      >
        <g data-body="">
          {cards ? (
            <g data-fan="">
              {card(1)}
              {card(3, state === 'expired' ? 'dim' : undefined)}
              {card(2, undefined, onCard)}
            </g>
          ) : (
            <path data-part="gh" data-b="" className="dash" d={CARD} />
          )}
          {seat ? (
            <>
              <path data-part="l1" className="o" d={LEG_L} />
              <path data-part="l2" className="o" d={LEG_R} />
            </>
          ) : null}
          <rect className="o" x="16" y="30" width="64" height="36" rx="9" />
          <rect className="st" x="20" y="34" width="56" height="28" rx="6" />
          <rect className="a" x="36" y="37" width="24" height="16" rx="7" />
          <g data-look="">
            <g data-part="eyes" data-b="">
              <ellipse className="e" cx="43.5" cy="43.5" rx="1.7" ry="2.1" />
              <ellipse className="e" cx="52.5" cy="43.5" rx="1.7" ry="2.1" />
            </g>
            {mood === 'happy' ? <path data-part="joy" className="m" d={JOY} /> : null}
            {brows ? <path data-part="br" className="m" d={brows} /> : null}
            {face}
          </g>
          <path className="m" d={(mood && MOUTH[mood]) ?? SMILE} />
          {front}
          {state === 'lost' ? (
            <g data-part="ln">
              <path className="h" d="M71 30l6 6" />
              <circle className="o" cx="66" cy="25" r="7" />
            </g>
          ) : null}
        </g>
      </g>
    </Art>
  );
}
