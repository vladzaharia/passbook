import type { ReactNode, Ref } from 'react';
import type { ArtSize } from './base.tsx';
import { WalletArt, type WalletMood, type WalletState } from './wallet.tsx';

/** What it acts out (scenes/*.css). beat replays the mood's beat on a click, never on its own. */
export type BuddyScene =
  | 'search'
  | 'inspect'
  | 'sweep'
  | 'mend'
  | 'tug'
  | 'plug'
  | 'peek'
  | 'flip'
  | 'cheer'
  | 'wave'
  | 'tear'
  | 'nudge'
  | 'beat';

export interface BuddyProps {
  mood?: WalletMood;
  state?: WalletState;
  /** The entity's object (a small EntityArt), standing on the same edge at the buddy's side. */
  prop?: ReactNode;
  size?: ArtSize;
  /** Where on the edge: centred (state boxes), or at the start or end inset (cards with a title). */
  at?: 'start' | 'end';
  still?: boolean;
  scene?: BuddyScene;
  /** A change replays the scene (Retry). */
  replay?: number;
  className?: string;
}

/** The search scene's "?", hidden at rest. */
const ASK = (
  <path
    data-q=""
    className="m f"
    opacity="0"
    d="M44.8 10.4a3.3 3.3 0 1 1 4.6 3c-.9.4-1.4 1.2-1.4 2.1v.8M48 20.2h.01"
  />
);

/** The tear scene's drop under the left eye, hidden at rest. */
const TEAR = (
  <path
    data-tear=""
    className="c1"
    opacity="0"
    stroke="none"
    d="M42.6 45.6c-1.3 1.9-2.4 3.4-2.4 4.7a2.4 2.4 0 0 0 4.8 0c0-1.3-1.1-2.8-2.4-4.7Z"
  />
);

/**
 * The buddy's markup, SSR-safe (no hooks): buddy.tsx adds the scene's replay in the app; SSR pages
 * render it as is (state-art.tsx), `playOnLoad` marking the scene to play once without script.
 */
export function BuddyArt({
  mood,
  state = 'login',
  prop,
  size = 'lg',
  at,
  still,
  scene = 'beat',
  playOnLoad,
  className,
  ref,
}: Omit<BuddyProps, 'replay'> & { playOnLoad?: boolean; ref?: Ref<HTMLSpanElement> }) {
  return (
    <span
      ref={ref}
      aria-hidden
      data-buddy=""
      data-replay=""
      data-scene={scene}
      data-prop={prop ? '' : undefined}
      data-at={at}
      data-run={playOnLoad ? 'load' : undefined}
      className={className ? `wl-buddy ${className}` : 'wl-buddy'}
    >
      <WalletArt
        state={state}
        size={size}
        seat
        beat={false}
        still={still}
        mood={mood}
        front={scene === 'search' ? ASK : scene === 'tear' ? TEAR : undefined}
      />
      {prop ? <span className="wl-buddy-prop">{prop}</span> : null}
    </span>
  );
}
