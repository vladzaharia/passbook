import type { ArtSize } from './base.tsx';
import { BuddyArt } from './buddy-art.tsx';
import { LockArt } from './lock.tsx';
import { ACTED_STATES, type ActedState } from './state-acts.ts';
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

/** The acted states' props, drawn statically here (SSR); the app draws them lazily. */
const PROP = { unplugged: UnpluggedArt, torn: TornArt, lock: LockArt } as const;
const isActed = (name: StateArtName): name is ActedState => Object.hasOwn(ACTED_STATES, name);

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
  if (isActed(name)) {
    const act = ACTED_STATES[name];
    const Prop = act.prop ? PROP[act.prop] : null;
    return (
      <BuddyArt
        mood="sad"
        size={size}
        scene={act.scene}
        state={act.state ?? 'login'}
        prop={Prop ? <Prop size="sm" /> : undefined}
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
