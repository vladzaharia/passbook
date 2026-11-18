/** The desk's value regions: the amount, Confirm, Cancel and a Manager's PIN. */
import { settleShown } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { apply } from './reduce-action.ts';
import type { ScanEvent } from './types.ts';

type Of<T extends ScanEvent['type']> = Extract<ScanEvent, { type: T }>;

export function amount(s: MachineState, ev: Of<'amount'>, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'member' || !l.picker || ev.value === null) return same(s);
  return out({
    ...s,
    loop: { ...l, picker: { ...l.picker, amount: ev.value } },
    lastActivity: env.now,
  });
}

export function value(s: MachineState, ev: Of<'value'>, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'member' || !l.picker) return same(s);
  return out({
    ...s,
    loop: { ...l, picker: { ...l.picker, value: ev.value } },
    lastActivity: env.now,
  });
}

/** Confirm: the open picker's draft goes to the server. */
export function confirm(s: MachineState, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'member' || !l.picker) return same(s);
  return apply(s, l, l.picker, env);
}

export function cancel(s: MachineState, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'member' || !l.picker) return same(s);
  return out({ ...s, loop: { ...l, picker: null }, lastActivity: env.now });
}

/** A Manager's PIN: the draft that needed approval goes again under a new key, with `approval`. */
export function approve(s: MachineState, ev: Of<'approve'>, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'verdict' || l.outcome.reason !== 'needs_approval' || !l.draft) return same(s);
  const key = env.id();
  const draft = {
    ...l.draft,
    approval: { ...(ev.staffId ? { staffId: ev.staffId } : {}), pin: ev.pin },
  };
  return out(
    {
      ...s,
      ignore: settleShown(s.ignore, env.now),
      loop: {
        s: 'applying',
        input: l.input,
        card: l.card,
        draft,
        key,
        since: env.now,
        slow: false,
        next: null,
        retry: l.outcome,
      },
      lastActivity: env.now,
    },
    [{ c: 'act', key, input: l.input, draft }],
  );
}
