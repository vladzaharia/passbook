/** The `read` table (AC 3.4 with SA 7.5): what a read does in each loop state. */
import type { ScanInput } from '../input/types.ts';
import { SCAN_TIMING } from '../timing.ts';
import { TAG_OFFLINE } from './assign-state.ts';
import { findIgnore, settleShown } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { same } from './internal.ts';
import { headlineOf, localOutcome } from './outcome.ts';
import type { Cmd, Draft, Ignore, Loop } from './types.ts';
import { cardBehind, enterVerdict } from './verdict.ts';
import { verdictLine } from './verdict-lines.ts';

const chipFor = (hit: Ignore | undefined): Cmd => ({
  c: 'chip',
  chip: hit?.why === 'refused' ? { same: hit.headline ?? '' } : 'just_now',
});

const inputOf = (l: Loop): ScanInput | null =>
  l.s === 'checking' ||
  l.s === 'applying' ||
  l.s === 'member' ||
  l.s === 'reviewing' ||
  l.s === 'verdict'
    ? l.input
    : null;

/** The draft the door sends for a read: the armed action, or `auto`. */
export const doorDraft = (s: MachineState): Draft | 'auto' =>
  s.armed ? { actionId: s.armed.actionId, amount: s.armed.amount } : 'auto';

/** Starts checking `input`: a local refusal, an offline verdict, or the request. */
export function begin(s: MachineState, input: ScanInput, env: Env): Out {
  const { now } = env;
  const from = s.loop;
  const base: MachineState = {
    ...s,
    overlay: s.overlay === 'lookup' || s.overlay === 'camera' ? null : s.overlay,
    reader:
      input.method === 'wedge' || input.method === 'nfc' ? { ...s.reader, lastAt: now } : s.reader,
    ignore: from.s === 'verdict' ? settleShown(s.ignore, now) : s.ignore,
    lastActivity: now,
    slowed: false,
  };
  const card = cardBehind(s);
  const cmds: Cmd[] = [];
  if (from.s === 'paused') {
    if (from.reason === 'idle') {
      cmds.push({ c: 'camera', op: s.released || s.camera === 'off' ? 'start' : 'resume' });
      base.released = false;
    } else base.pausedReason = from.reason;
    base.pausedAt = undefined;
  }
  if (input.local) {
    const outcome = localOutcome('refused', input.local, s.counts);
    const v = enterVerdict(base, { input, card, outcome }, env);
    return { state: v.state, cmds: [...cmds, ...v.cmds] };
  }
  if (!s.online && s.offline.mode !== 'stop' && input.code !== undefined && !input.tag) {
    // O8: the door decides from the list, or asks staff. The controller answers under this key.
    const key = input.id;
    return {
      state: {
        ...base,
        loop: { s: 'checking', input, key, since: now, slow: false, next: null },
      },
      cmds: [...cmds, { c: 'offline.decide', key, input }],
    };
  }
  if (!s.online) {
    // Tags need a connection; a card can still wait for one.
    const outcome = input.tag
      ? localOutcome('system', TAG_OFFLINE, s.counts)
      : localOutcome('system', 'network', s.counts);
    const v = enterVerdict(base, { input, card, outcome }, env);
    return { state: v.state, cmds: [...cmds, ...v.cmds] };
  }
  const retry = s.unsure.find(
    (u) =>
      (u.sig === input.sig || (input.passId !== undefined && u.passId === input.passId)) &&
      now - u.at < SCAN_TIMING.UNSURE_RETRY_WINDOW,
  );
  const key = retry?.key ?? input.id;
  const live = s.camera === 'live' && !base.pausedReason;
  if (live) cmds.push({ c: 'camera', op: 'pause' });
  cmds.push({ c: 'beat', beat: input.method === 'camera' ? 'lock' : 'look' });
  const act = s.posture === 'door' || s.armed !== null;
  cmds.push(act ? { c: 'act', key, input, draft: doorDraft(s) } : { c: 'resolve', key, input });
  return {
    state: {
      ...base,
      loop: { s: 'checking', input, key, since: now, slow: false, next: null },
    },
    cmds,
  };
}

/** What a read does, from the state before it: `begin` it, `park` it behind the open one, drop it as a `duplicate`, or `assign` consumes it. */
export type ReadFate = 'begin' | 'park' | 'duplicate' | 'assign';

/** The classifier `read` and the reducer share. A blocked scanner ignores the read (`duplicate`). */
export function readFate(s: MachineState, input: ScanInput, now: number): ReadFate {
  if (s.block) return 'duplicate';
  if (s.assign) return 'assign';
  const l = s.loop;
  const hit = findIgnore(s.ignore, input.sig, now);
  const isSame = inputOf(l)?.sig === input.sig;
  switch (l.s) {
    case 'ready':
    case 'paused':
      return hit ? 'duplicate' : 'begin';
    case 'checking':
    case 'applying':
      return isSame || hit ? 'duplicate' : 'park';
    case 'member':
    case 'reviewing':
      if (isSame || hit) return 'duplicate';
      return l.s === 'reviewing' || l.picker !== null ? 'park' : 'begin';
    case 'verdict':
      if (isSame) return l.outcome.kind === 'system' ? 'begin' : 'duplicate';
      if (hit) return 'duplicate';
      return now < l.openFrom ? 'park' : 'begin';
  }
}

/** A read from any source, in every loop state. */
export function read(s: MachineState, input: ScanInput, env: Env): Out {
  if (s.block) return same(s);
  const { now } = env;
  const l = s.loop;
  const fate = readFate(s, input, now);
  const hit = findIgnore(s.ignore, input.sig, now);
  const chip = (c: Cmd = chipFor(hit)): Out => ({ state: { ...s, lastActivity: now }, cmds: [c] });
  const isSame = inputOf(l)?.sig === input.sig;
  if (fate === 'begin') {
    const b = begin(s, input, env);
    return l.s === 'verdict' && !isSame
      ? { state: b.state, cmds: [{ c: 'beat', beat: 'cut' }, ...b.cmds] }
      : b;
  }
  if (fate === 'park') {
    if (l.s === 'member' || l.s === 'reviewing')
      return {
        state: { ...s, loop: { ...l, held: input } },
        cmds: [{ c: 'sound', tone: 'heads_up' }],
      };
    if (l.s === 'checking' || l.s === 'applying' || l.s === 'verdict')
      return { state: { ...s, loop: { ...l, next: input } }, cmds: [] };
    return same(s);
  }
  switch (l.s) {
    case 'checking':
    case 'applying':
      return same(s);
    case 'member':
    case 'reviewing':
      return isSame ? chip({ c: 'chip', chip: 'already_open' }) : chip();
    case 'verdict':
      if (isSame && (l.outcome.kind === 'heads_up' || l.outcome.kind === 'refused'))
        return chip({
          c: 'chip',
          chip: { same: verdictLine(l.outcome, now)?.headline ?? headlineOf(l.outcome.reason) },
        });
      return isSame ? chip({ c: 'chip', chip: 'just_now' }) : chip();
    default:
      return chip();
  }
}
