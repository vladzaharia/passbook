import type { ReactNode } from 'react';
import type { ArtSize } from './base.tsx';
import { BuddyArt, type BuddyScene } from './buddy-art.tsx';
import { LockArt } from './lock.tsx';
import { TornArt } from './torn.tsx';
import { UnpluggedArt } from './unplugged.tsx';
import { WalletArt, type WalletState } from './wallet.tsx';
import { CHECK, HOURGLASS, KEY } from './wallet-states.tsx';

/**
 * A state's art, one composition per meaning in the app and on SSR pages: login (waiting for you),
 * confirm (a check on the top card), break-glass (a key turns), expired (the gold pass droops),
 * throttled (a rate limit: the hourglass), broken (an error: plug), lost (a route not found:
 * peek), torn (an entity not found: mend), no-access (forbidden: tug).
 */
export type StateArtName =
  | 'login'
  | 'confirm'
  | 'break-glass'
  | 'expired'
  | 'throttled'
  | 'broken'
  | 'lost'
  | 'torn'
  | 'no-access';

/** Refusals and failures: the sad buddy acts it out beside its prop, as the app's state boxes do. */
const ACTED: Partial<Record<StateArtName, { scene: BuddyScene; prop?: ReactNode; lost?: true }>> = {
  broken: { scene: 'plug', prop: <UnpluggedArt size="sm" /> },
  lost: { scene: 'peek', lost: true },
  torn: { scene: 'mend', prop: <TornArt size="sm" /> },
  'no-access': { scene: 'tug', prop: <LockArt size="sm" /> },
};

/**
 * The rest stand seated with their state's part; a click waves hello. `failed` (a refused form)
 * makes any of them sad. SSR-safe: `playOnLoad` plays an acted scene once on load, with no script.
 */
export function StateArt({
  name,
  size = 'xl',
  failed = false,
  playOnLoad,
}: {
  name: StateArtName;
  size?: ArtSize;
  failed?: boolean;
  playOnLoad?: boolean;
}) {
  const acted = ACTED[name];
  if (acted) {
    return (
      <BuddyArt
        mood="sad"
        size={size}
        scene={acted.scene}
        state={acted.lost ? 'lost' : 'login'}
        prop={acted.prop}
        playOnLoad={playOnLoad}
      />
    );
  }
  const state: WalletState =
    name === 'confirm' || name === 'break-glass' || name === 'expired' ? name : 'login';
  const sad = failed || name === 'expired' || name === 'throttled';
  return (
    <span data-replay="" data-scene="hello">
      <WalletArt
        state={state}
        size={size}
        seat
        {...(sad ? { mood: 'sad' as const } : {})}
        onCard={name === 'confirm' ? CHECK : undefined}
        front={name === 'break-glass' ? KEY : undefined}
        aside={name === 'throttled' ? HOURGLASS : undefined}
      />
    </span>
  );
}
