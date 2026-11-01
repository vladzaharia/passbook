import { Art, type ArtProps } from './base.tsx';

export type WalletState =
  | 'login'
  | 'empty'
  | 'lost'
  | 'confirm'
  | 'expired'
  | 'no-access'
  | 'break-glass';

export interface WalletArtProps extends ArtProps {
  state?: WalletState;
  mood?: 'flat';
  /** Top card lifts 6 px. */
  lift?: boolean;
}

const CARD = 'M40 9h16a3 3 0 0 1 3 3v25a3 3 0 0 1-3 3H40a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3Z';
const card = (n: 1 | 2 | 3, extra?: string) => (
  <g data-part={`c${n}`} data-i={n - 1} className={extra}>
    <path className={`c${n}`} d={CARD} />
    <path className="hl" d="M41 14h9" />
  </g>
);

/** The holder mascot. SSR-safe: no inline styles; pages inline ART_CSS (css.ts). */
export function WalletArt({ state = 'empty', mood, lift, ...props }: WalletArtProps) {
  const cards = state !== 'empty' && state !== 'lost';
  return (
    <Art name="wallet" state={state} {...props}>
      <g data-part="w" data-b="" data-mood={mood} data-lift={lift ? '' : undefined}>
        {cards ? (
          <>
            {card(1)}
            {card(3, state === 'expired' ? 'dim' : undefined)}
            {card(2)}
          </>
        ) : (
          <path data-part="gh" data-b="" className="dash" d={CARD} />
        )}
        {state === 'confirm' ? <path data-part="ck" className="ck" d="M43.5 20l3 3 6-6.5" /> : null}
        {state === 'no-access' ? (
          <g data-part="lk">
            <path data-part="sh" d="M44 18v-3a4 4 0 0 1 8 0v3" />
            <rect className="o" x="41" y="17.5" width="14" height="11" rx="2.5" />
          </g>
        ) : null}
        <rect className="o" x="16" y="30" width="64" height="36" rx="9" />
        <rect className="st" x="20" y="34" width="56" height="28" rx="6" />
        <rect className="a" x="36" y="37" width="24" height="16" rx="7" />
        <g data-part="eyes" data-b="">
          <ellipse className="e" cx="43.5" cy="43.5" rx="1.7" ry="2.1" />
          <ellipse className="e" cx="52.5" cy="43.5" rx="1.7" ry="2.1" />
        </g>
        <path className="m" d="M45.5 47.5q2.5 2 5 0" />
        {state === 'break-glass' ? (
          <g data-part="key">
            <path className="m" d="M57 44h8" />
            <circle className="o" cx="68.5" cy="44" r="3.5" />
          </g>
        ) : null}
        {state === 'lost' ? (
          <g data-part="ln">
            <path className="h" d="M71 30l6 6" />
            <circle className="o" cx="66" cy="25" r="7" />
          </g>
        ) : null}
      </g>
    </Art>
  );
}
