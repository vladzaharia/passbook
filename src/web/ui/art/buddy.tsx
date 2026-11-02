import type { ReactNode } from 'react';
import type { ArtSize } from './base.tsx';
import { WalletArt, type WalletMood, type WalletState } from './wallet.tsx';

export interface BuddyProps {
  mood?: WalletMood;
  state?: WalletState;
  /** The entity's object (a small EntityArt), standing on the same edge at the buddy's side. */
  prop?: ReactNode;
  size?: ArtSize;
  still?: boolean;
  className?: string;
}

/**
 * The mascot seated on its host's top edge (art-buddy.css): the host is position: relative and
 * leaves 11/12 of the art's height free above that edge. One per view; decorative.
 */
export function Buddy({ mood, state = 'login', prop, size = 'lg', still, className }: BuddyProps) {
  return (
    <span
      aria-hidden
      data-buddy=""
      data-prop={prop ? '' : undefined}
      className={className ? `wl-buddy ${className}` : 'wl-buddy'}
    >
      <WalletArt state={state} size={size} seat beat={false} still={still} mood={mood} />
      {prop ? <span className="wl-buddy-prop">{prop}</span> : null}
    </span>
  );
}
