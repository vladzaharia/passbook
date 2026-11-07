import type { Env, MachineState, Out } from './internal.ts';
import { same } from './internal.ts';
import { pick } from './reduce-action.ts';
import type { Card } from './types.ts';

/** Only the lookup confirmation calls this; selecting or resolving a pass never does. */
export function manualCheckIn(s: MachineState, card: Card, actionId: string, env: Env): Out {
  if (
    !s.started ||
    s.block ||
    s.loop.s === 'checking' ||
    s.loop.s === 'applying' ||
    s.loop.s === 'reviewing'
  )
    return same(s);
  const action = card.actions.find((a) => a.id === actionId);
  if (action?.kind !== 'check_in' || !action.available || action.lock) return same(s);
  const input = {
    method: 'manual' as const,
    passId: card.passId,
    sig: `p:${card.passId}`,
    id: env.id(),
    at: env.now,
  };
  return pick(
    {
      ...s,
      overlay: null,
      card: null,
      loop: {
        s: 'member',
        input,
        card,
        since: env.now,
        band: null,
        picker: null,
        held: null,
        locked: false,
      },
    },
    { type: 'pick', actionId },
    env,
  );
}
