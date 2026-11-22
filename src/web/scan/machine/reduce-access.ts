/** Access and occupancy events: a held scan turned around, and a desk's `resolved`. */
import { SCAN_TIMING } from '../timing.ts';
import type { AccessEvent, DirectionDraft, ResolvedOutcome } from './access-events.ts';
import { accessBeat } from './access-events.ts';
import { announceOf } from './access-view.ts';
import { settleShown } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import type { Cmd } from './types.ts';

type Of<T extends AccessEvent['type']> = Extract<AccessEvent, { type: T }>;

/** How long a refused card can still turn (OC 6.5). */
export const RESOLVE_WINDOW_MS = 60_000;

/** Tap in or Tap out on a hold: the same scan under a new key with the direction named. */
export function turn(s: MachineState, ev: Of<'turn'>, env: Env): Out {
  const l = s.loop;
  const exit = l.s === 'verdict' && l.outcome.kind === 'refused' && l.outcome.exitAllowed;
  if (l.s !== 'verdict' || (l.outcome.kind !== 'heads_up' && !exit)) return same(s);
  const draft: DirectionDraft = {
    actionId: l.outcome.action?.id ?? 'auto',
    amount: null,
    direction: ev.direction,
  };
  const key = env.id();
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
      },
      lastActivity: env.now,
    },
    [{ c: 'act', key, input: l.input, draft }],
  );
}

/**
 * A desk let the person in. The card of that scan turns in place when it is still up, or the
 * device's latest verdict under a minute old. Otherwise only its Recent row turns, and the next
 * person is never interrupted.
 */
export function resolved(s: MachineState, ev: Of<'resolved'>, env: Env): Out {
  const { now } = env;
  const by = ev.by.staff ?? undefined;
  const turned: ResolvedOutcome = { ...ev.outcome, ...(by ? { resolvedBy: by } : {}) };
  const recent = s.recent.map((r) =>
    r.scanId === ev.of
      ? { ...r, undoable: false, outcome: { ...turned, display: r.outcome.display } }
      : r,
  );
  const l = s.loop;
  if (l.s !== 'verdict' || l.outcome.scanId !== ev.of || now - l.since > RESOLVE_WINDOW_MS)
    return out({ ...s, recent });
  const desk = !s.armed && s.posture === 'desk' && l.card !== null;
  const end = now + SCAN_TIMING.OK_HOLD;
  const cmds: Cmd[] = [
    { c: 'sound', tone: 'ok' },
    { c: 'beat', beat: accessBeat('relent') },
    { c: 'announce', text: announceOf(turned, now), polite: true },
  ];
  return out(
    {
      ...s,
      recent,
      loop: {
        ...l,
        outcome: { ...turned, display: l.outcome.display, undoUntil: null },
        since: now,
        closeAt: desk ? null : end,
        settleAt: desk ? end : null,
      },
      lastActivity: now,
    },
    cmds,
  );
}
