/** Door-side actions: closing a verdict, Let in again, arming, undo, and the held-code buttons. */
import { settleShown } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { begin } from './reduce-read.ts';
import type { Cmd, Draft, ScanEvent } from './types.ts';
import { recentRow, tuckCard } from './verdict.ts';

type Of<T extends ScanEvent['type']> = Extract<ScanEvent, { type: T }>;

/** Verdict over, no desk card to keep: back to ready, the card tucks. */
export function toReady(s: MachineState, env: Env): Out {
  const tuck = tuckCard(s, env.now);
  return out(
    {
      ...s,
      ...tuck.patch,
      loop: s.pausedReason
        ? { s: 'paused', reason: s.pausedReason }
        : { s: 'ready', since: env.now, hint: 0 },
      ignore: settleShown(s.ignore, env.now),
      pausedReason: undefined,
      pausedAt: s.pausedReason ? env.now : undefined,
      lastActivity: env.now,
    },
    tuck.cmds,
  );
}

/** The flood's tint fades and the card stays up (desk). */
export function settle(s: MachineState, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'verdict' || !l.card) return toReady(s, env);
  if (l.next) return begin(s, l.next, env);
  return out({
    ...s,
    ignore: settleShown(s.ignore, env.now),
    loop: {
      s: 'member',
      input: l.input,
      card: l.card,
      since: env.now,
      band: l.outcome,
      picker: null,
      held: null,
      locked: false,
    },
  });
}

/** A verdict's hold ran out. */
export function closeVerdict(s: MachineState, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'verdict') return same(s);
  return l.next ? begin(s, l.next, env) : toReady(s, env);
}

export function dismiss(s: MachineState, env: Env): Out {
  const l = s.loop;
  if (l.s === 'verdict') {
    if (l.next) return begin(s, l.next, env);
    if (l.settleAt !== null && l.card) return settle(s, env);
    return toReady(s, env);
  }
  if (l.s === 'member' && !l.picker) return toReady(s, env);
  return same(s);
}

/** "Let in again" and the stop-flag confirm: the same scan under a new key. */
export function override(s: MachineState, ev: Of<'override'>, env: Env): Out {
  const l = s.loop;
  if (l.s !== 'verdict' || l.outcome.kind !== 'heads_up') return same(s);
  const draft: Draft = { actionId: ev.actionId, amount: null };
  if (l.outcome.reason === 'check_required') draft.confirmed = true;
  else if (l.outcome.scanId) {
    draft.override = true;
    draft.overrideOf = l.outcome.scanId;
  } else return same(s);
  const key = env.id();
  const now = env.now;
  return out(
    {
      ...s,
      ignore: settleShown(s.ignore, now),
      loop: {
        s: 'applying',
        input: l.input,
        card: l.card,
        draft,
        key,
        since: now,
        slow: false,
        next: null,
      },
      lastActivity: now,
    },
    [{ c: 'act', key, input: l.input, draft }],
  );
}

export const arm = (s: MachineState, ev: Of<'arm'>, env: Env): Out =>
  out({
    ...s,
    armed: { actionId: ev.actionId, amount: ev.amount, sticky: ev.sticky },
    lastActivity: env.now,
  });

export const disarm = (s: MachineState, env: Env): Out =>
  out({ ...s, armed: null, lastActivity: env.now });

export function undo(s: MachineState, ev: Of<'undo'>, env: Env): Out {
  const key = env.id();
  return out({ ...s, undo: { scanId: ev.scanId, key, since: env.now }, lastActivity: env.now }, [
    { c: 'undo', key, scanId: ev.scanId, ...(ev.approval ? { approval: ev.approval } : {}) },
  ]);
}

export function undone(s: MachineState, ev: Of<'undone'>, env: Env): Out {
  if (s.undo?.key !== ev.key) return same(s);
  const scanId = s.undo.scanId;
  const recent = s.recent.map((r) =>
    r.scanId === scanId
      ? { ...r, undoable: false, outcome: { ...r.outcome, action: ev.outcome.action } }
      : r,
  );
  const l = s.loop;
  const loop =
    l.s === 'member' && l.band?.scanId === scanId
      ? { ...l, band: ev.outcome }
      : l.s === 'verdict' && l.outcome.scanId === scanId
        ? {
            ...l,
            outcome: { ...ev.outcome, display: l.outcome.display },
            since: env.now,
            closeAt: env.now + 1200,
          }
        : l;
  const cmds: Cmd[] = [
    { c: 'sound', tone: 'undo' },
    { c: 'beat', beat: 'rewind' },
    { c: 'announce', text: 'Undone', polite: true },
  ];
  const row = recentRow(ev.outcome, env.now);
  return out(
    {
      ...s,
      undo: null,
      recent:
        row && !recent.some((r) => r.scanId === scanId) ? [row, ...recent].slice(0, 20) : recent,
      loop,
      counts: ev.outcome.counts.asOf >= (s.counts?.asOf ?? 0) ? ev.outcome.counts : s.counts,
    },
    cmds,
  );
}

/** "Another pass was scanned": Switch checks the held code, Keep editing drops it. */
export function switchHeld(s: MachineState, env: Env): Out {
  const l = s.loop;
  if ((l.s !== 'member' && l.s !== 'reviewing') || !l.held) return same(s);
  return begin({ ...s, loop: { ...l, held: null } }, l.held, env);
}
export function keepHeld(s: MachineState): Out {
  const l = s.loop;
  if ((l.s !== 'member' && l.s !== 'reviewing') || !l.held) return same(s);
  return out({ ...s, loop: { ...l, held: null } });
}
