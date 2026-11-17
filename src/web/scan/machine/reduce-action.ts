import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { localOutcome } from './outcome.ts';
import type { Card, Cmd, Draft, ScanEvent } from './types.ts';
import { enterVerdict } from './verdict.ts';

type Action = Card['actions'][number];

/** The amount a draft starts at: the action's fixed one, its default, or none. */
export function startAmount(action: Action): number | null {
  const a = action.amount;
  if (!a) return null;
  return 'fixed' in a ? a.fixed : (a.default ?? a.presets[0] ?? 1);
}

/** An amount to choose or a consequence to confirm comes before the request. */
const needsInput = (action: Action) =>
  action.confirm || (action.amount !== null && !('fixed' in action.amount));

/** Sends `draft` under a new key: the loop moves to `applying`. */
export function apply(
  s: MachineState,
  l: Extract<MachineState['loop'], { s: 'member' }>,
  draft: Draft,
  env: Env,
): Out {
  if (!s.online)
    return enterVerdict(
      s,
      { input: l.input, card: l.card, outcome: localOutcome('system', 'network', s.counts) },
      env,
    );
  // The previous auto/resolve request selected a card; this mutation needs its own replay key.
  const key = env.id();
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

/** The ready card's explicit action: a check-in or a fixed value action applies at once, the rest open a picker. */
export function pick(s: MachineState, ev: Extract<ScanEvent, { type: 'pick' }>, env: Env): Out {
  const l = s.loop;
  if (!s.started || s.block || l.s !== 'member') return same(s);
  const action = l.card.actions.find((a) => a.id === ev.actionId);
  // A locked action is the desk's to try: `needs_approval` offers the Manager PIN.
  if (!action || action.lock === 'role' || (!action.available && action.lock !== 'approval'))
    return same(s);
  const draft: Draft = { actionId: action.id, amount: startAmount(action) };
  if (action.kind !== 'check_in' && needsInput(action) && action.lock === null)
    return out({ ...s, loop: { ...l, picker: draft }, lastActivity: env.now });
  return apply(s, l, draft, env);
}
