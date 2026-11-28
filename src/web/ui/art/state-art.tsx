import type { ArtSize } from './base.tsx';
import { BuddyArt } from './buddy-art.tsx';
import { LensOverlay } from './lens.tsx';
import { LockArt } from './lock.tsx';
import { ACTED_STATES, type ActedState } from './state-acts.ts';
import { ClockArt, PlanTicketArt, SignArt } from './state-props.tsx';
import { TornArt } from './torn.tsx';
import { UnpluggedArt } from './unplugged.tsx';
import { WalletArt, type WalletState } from './wallet.tsx';
import { CHECK, HOURGLASS, KEY } from './wallet-states.tsx';

/**
 * A state's art, one composition per meaning in the app and on SSR pages: login (waiting for you),
 * confirm (a check on the top card), break-glass (a key turns), expired (the gold pass droops),
 * throttled (a rate limit: the hourglass), broken (an error: plug), lost (a route not found:
 * peek), torn (an entity not found: mend), no-access (forbidden: tug). The rest: empty (the
 * wallet with nothing in it), filtered (the same, dimmed under a lens), paused (flat, holding a
 * sign), closed (flat, a clock), suspended (tugs the lock, as no-access) and plan-ticket (the
 * plan's ticket, rising once).
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
  | 'no-access'
  | 'empty'
  | 'filtered'
  | 'paused'
  | 'closed'
  | 'suspended'
  | 'plan-ticket';

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
  plan = 'trial',
}: {
  name: StateArtName;
  size?: ArtSize;
  failed?: boolean;
  playOnLoad?: boolean;
  /** plan-ticket: the plan preset id (src/generated/plan-icons.ts). */
  plan?: string;
}) {
  if (name === 'plan-ticket') return <PlanTicketArt plan={plan} size={size} />;
  if (name === 'paused' || name === 'closed') {
    const Prop = name === 'paused' ? SignArt : ClockArt;
    return (
      <BuddyArt mood="flat" size={size} scene="beat" state="empty" prop={<Prop size="sm" />} />
    );
  }
  if (name === 'filtered') {
    return (
      <span data-replay="" data-scene="hello" className="relative inline-block">
        <span style={{ opacity: 0.6 }}>
          <WalletArt state="empty" size={size} seat />
        </span>
        <LensOverlay size="sm" className="absolute right-0 bottom-0" />
      </span>
    );
  }
  const key = name === 'suspended' ? 'no-access' : name;
  if (isActed(key)) {
    const act = ACTED_STATES[key];
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
    name === 'confirm' || name === 'break-glass' || name === 'expired' || name === 'empty'
      ? name
      : 'login';
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
