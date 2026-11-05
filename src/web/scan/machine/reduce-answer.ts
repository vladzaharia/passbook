/** Answers, failures, late answers and unsure expiry (AC 3.4). */
import { SCAN_TIMING } from '../timing.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { localOutcome } from './outcome.ts';
import { announcementFor } from './present.ts';
import { begin, doorDraft } from './reduce-read.ts';
import type { Cmd, Draft, FailCode, ScanEvent, ScanOutcome, Unsure } from './types.ts';
import { enterVerdict, raiseCard, recentRow, tuckCard, withRow } from './verdict.ts';

type Answer = Extract<ScanEvent, { type: 'answer' }>;
type Fail = Extract<ScanEvent, { type: 'fail' }>;

const without = (s: MachineState, key: string): MachineState => ({
  ...s,
  unsure: s.unsure.filter((u) => u.key !== key),
});

/** The desk's member card opened. */
function enterMember(s: MachineState, ev: Answer, env: Env): Out {
  const { now } = env;
  const l = s.loop;
  if (l.s !== 'checking' || !ev.outcome.card) return fail(s, failOf(ev.key, 'server'), env);
  const card = ev.outcome.card;
  const raised = raiseCard(s, 'panel', l.input.id, now);
  const cmds: Cmd[] = [];
  if (s.camera === 'live' && !s.pausedReason) cmds.push({ c: 'camera', op: 'resume' });
  cmds.push(...raised.cmds, { c: 'beat', beat: 'look' });
  cmds.push({ c: 'announce', text: card.title, polite: true });
  const opened: MachineState = {
    ...s,
    ...raised.patch,
    loop: {
      s: 'member',
      input: l.input,
      card,
      since: now,
      band: null,
      picker: null,
      held: null,
      locked: false,
    },
    counts: ev.outcome.counts.asOf >= (s.counts?.asOf ?? 0) ? ev.outcome.counts : s.counts,
    lastActivity: now,
  };
  if (!l.next) return out(opened, cmds);
  const next = begin(opened, l.next, env);
  return out(next.state, [...cmds, ...next.cmds]);
}

const asDraft = (d: Draft | 'auto'): Draft =>
  d === 'auto' ? { actionId: 'auto', amount: null } : d;

const failOf = (key: string, error: FailCode): Fail => ({ type: 'fail', key, error });

export function answer(s: MachineState, ev: Answer, env: Env): Out {
  const l = s.loop;
  if ((l.s !== 'checking' && l.s !== 'applying') || l.key !== ev.key) return late(s, ev, env);
  const dropped = s.unsure.some((u) => u.key === ev.key);
  const base = dropped ? without(s, ev.key) : s;
  const drop: Cmd[] = dropped ? [{ c: 'unsure.drop', key: ev.key }] : [];
  if (ev.outcome.kind === 'ready' && l.s === 'checking') {
    const m = enterMember(base, ev, env);
    return out(m.state, [...drop, ...m.cmds]);
  }
  const v = enterVerdict(
    base,
    {
      input: l.input,
      card: l.s === 'applying' ? l.card : null,
      outcome: ev.outcome,
      resumeCamera: l.s === 'checking',
      next: l.next,
    },
    env,
  );
  return out(v.state, [...drop, ...v.cmds]);
}

function block(s: MachineState, kind: NonNullable<MachineState['block']>, env: Env): Out {
  const tuck = tuckCard(s, env.now);
  const cmds: Cmd[] = [{ c: 'beat', beat: 'cut' }, ...tuck.cmds];
  if (kind !== 'staff') cmds.push({ c: 'camera', op: 'stop' }, { c: 'wake', op: 'release' });
  return out(
    {
      ...s,
      ...tuck.patch,
      block: kind,
      loop: { s: 'ready', since: env.now, hint: 0 },
      undo: null,
    },
    cmds,
  );
}

export function fail(s: MachineState, ev: Fail, env: Env): Out {
  const { now } = env;
  if (ev.error === 'revoked' || ev.error === 'suspended' || ev.error === 'signed_out')
    return block(s, ev.error, env);
  if (ev.error === 'staff_required') return block(s, 'staff', env);
  if (s.undo?.key === ev.key)
    return out({ ...s, undo: null }, [
      { c: 'announce', text: "Couldn't undo. Try again.", polite: false },
    ]);
  const l = s.loop;
  if ((l.s !== 'checking' && l.s !== 'applying') || l.key !== ev.key) return same(s);
  const act = l.s === 'applying' || s.posture === 'door' || s.armed !== null;
  let outcome: ScanOutcome;
  let state = s;
  const cmds: Cmd[] = [];
  if (ev.error === 'network' || ev.error === 'timeout') {
    if (act) {
      const entry: Unsure = {
        key: l.key,
        sig: l.input.sig,
        ...(l.input.passId ? { passId: l.input.passId } : {}),
        draft: l.s === 'applying' ? l.draft : asDraft(doorDraft(s)),
        at: now,
        state: 'retrying',
      };
      if (!s.unsure.some((u) => u.key === l.key)) {
        state = { ...s, unsure: [...s.unsure, entry] };
        cmds.push({ c: 'unsure.keep', entry });
      }
      outcome = localOutcome('system', 'unconfirmed', s.counts);
    } else outcome = localOutcome('system', ev.error, s.counts);
  } else if (ev.error === 'rate_limited') {
    outcome = localOutcome('system', 'rate_limited', s.counts, {
      retryAfterMs: ev.retryAfterMs ?? SCAN_TIMING.OK_HOLD,
    });
  } else if (ev.error === 'forbidden') {
    outcome = localOutcome('refused', 'not_accepted', s.counts);
  } else {
    outcome = localOutcome(
      'system',
      'server',
      s.counts,
      ev.requestId ? { requestId: ev.requestId } : {},
    );
  }
  const v = enterVerdict(
    state,
    {
      input: l.input,
      card: l.s === 'applying' ? l.card : null,
      outcome,
      resumeCamera: l.s === 'checking',
      next: l.next,
    },
    env,
  );
  return out(v.state, [...cmds, ...v.cmds]);
}

/** An answer to a request the screen has moved on from: an unsure retry that landed. */
function late(s: MachineState, ev: Answer, env: Env): Out {
  const entry = s.unsure.find((u) => u.key === ev.key);
  if (!entry) return same(s);
  const { now } = env;
  const base = without(s, ev.key);
  const drop: Cmd = { c: 'unsure.drop', key: ev.key };
  const l = base.loop;
  const shown = (l.s === 'verdict' || l.s === 'member') && l.input.sig === entry.sig;
  if (shown && l.s === 'verdict') {
    const v = enterVerdict(
      base,
      {
        input: l.input,
        card: l.card,
        outcome: ev.outcome,
        inPlace: true,
        next: l.next,
        replaceRecentAt: entry.at,
      },
      env,
    );
    return out(v.state, [drop, ...v.cmds]);
  }
  const row = recentRow(ev.outcome, now);
  const recent = withRow(base.recent, row, entry.at);
  const counts =
    ev.outcome.counts.asOf >= (base.counts?.asOf ?? 0) ? ev.outcome.counts : base.counts;
  const loop = shown && l.s === 'member' ? { ...l, band: ev.outcome, locked: false } : base.loop;
  return out({ ...base, recent, counts, loop }, [
    drop,
    { c: 'announce', text: announcementFor(ev.outcome) ?? '', polite: true },
  ]);
}

/** The unsure window ended: the row, and an open card for that pass, say so. */
export function expireUnsure(s: MachineState, key: string): Out {
  const entry = s.unsure.find((u) => u.key === key);
  if (!entry) return same(s);
  const still = localOutcome('system', 'still_unconfirmed', s.counts);
  const row = recentRow(still, entry.at);
  const l = s.loop;
  let loop = l;
  if (l.s === 'member' && l.input.sig === entry.sig) loop = { ...l, band: still, locked: true };
  else if (l.s === 'verdict' && l.input.sig === entry.sig && l.outcome.reason === 'unconfirmed')
    loop = { ...l, outcome: still };
  return out({
    ...s,
    unsure: s.unsure.map((u) => (u.key === key ? { ...u, state: 'expired' as const } : u)),
    recent: withRow(s.recent, row, entry.at),
    loop,
  });
}
