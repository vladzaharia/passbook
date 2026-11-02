import type { ReactNode } from 'react';
import type { ArtSize } from './base.tsx';
import { useScene } from './replay.ts';
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
  | 'beat';

export interface BuddyProps {
  mood?: WalletMood;
  state?: WalletState;
  /** The entity's object (a small EntityArt), standing on the same edge at the buddy's side. */
  prop?: ReactNode;
  size?: ArtSize;
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

/**
 * The mascot seated on its host's top edge (art-wallet.css): the host is position: relative and
 * leaves 11/12 of the art's height free above that edge. One per view; decorative. Its scene runs
 * once in view and replays on a click (replay.ts).
 */
export function Buddy({
  mood,
  state = 'login',
  prop,
  size = 'lg',
  still,
  scene = 'beat',
  replay,
  className,
}: BuddyProps) {
  const { ref } = useScene<HTMLSpanElement>(!still && scene !== 'beat', replay);
  return (
    <span
      ref={ref}
      aria-hidden
      data-buddy=""
      data-replay=""
      data-scene={scene}
      data-prop={prop ? '' : undefined}
      className={className ? `wl-buddy ${className}` : 'wl-buddy'}
    >
      <WalletArt
        state={state}
        size={size}
        seat
        beat={false}
        still={still}
        mood={mood}
        front={scene === 'search' ? ASK : undefined}
      />
      {prop ? <span className="wl-buddy-prop">{prop}</span> : null}
    </span>
  );
}
