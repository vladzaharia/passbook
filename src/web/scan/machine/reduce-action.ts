import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { localOutcome } from './outcome.ts';
import type { Cmd, ScanEvent } from './types.ts';
import { enterVerdict } from './verdict.ts';

/** The ready card's explicit check-in; value-action pickers belong to the desk milestone. */
export function pick(s: MachineState, ev: Extract<ScanEvent, { type: 'pick' }>, env: Env): Out {
  const l = s.loop;
  if (!s.started || s.block || l.s !== 'member') return same(s);
  const action = l.card.actions.find((a) => a.id === ev.actionId);
  if (action?.kind !== 'check_in' || !action.available || action.lock) return same(s);
  if (!s.online)
    return enterVerdict(
      s,
      { input: l.input, card: l.card, outcome: localOutcome('system', 'network', s.counts) },
      env,
    );
  // The previous auto/resolve request selected a card; this mutation needs its own replay key.
  const key = env.id();
  const draft = { actionId: action.id, amount: null };
  const cmds: Cmd[] = [];
  if (s.camera === 'live') cmds.push({ c: 'camera', op: 'pause' });
  cmds.push({ c: 'act', key, input: l.input, draft });
  return out(
    {
      ...s,
      loop: {
        s: 'applying',
        input: l.input,
        card: l.card,
        draft,
        key,
        since: env.now,
        slow: false,
        next: null,
      },
      lastActivity: env.now,
    },
    cmds,
  );
}
