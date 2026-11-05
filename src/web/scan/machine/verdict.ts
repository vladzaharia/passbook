/** Entering a verdict, and the result card layer's rise, swap and tuck. */
import type { ScanInput } from '../input/types.ts';
import { SCAN_TIMING } from '../timing.ts';
import { acceptedIgnore, addIgnore, refusedIgnore, settleShown, shownIgnore } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { headlineOf } from './outcome.ts';
import { presentOutcome } from './present.ts';
import type { Card, CardLayer, Cmd, Recent, ScanOutcome } from './types.ts';

/** Raises a card, or swaps it in over the one that is up. */
export function raiseCard(
  s: MachineState,
  kind: CardLayer['kind'],
  id: string,
  now: number,
): { patch: Pick<MachineState, 'card' | 'cardAt'>; cmds: Cmd[] } {
  const patch = { card: { phase: 'rising' as const, id, kind }, cardAt: now };
  return { patch, cmds: [s.card ? { c: 'card.swap', kind, id } : { c: 'card.rise', kind, id }] };
}

/** Tucks the card that is up. A card already tucking, or none, does nothing. */
export function tuckCard(
  s: MachineState,
  now: number,
): { patch: Partial<MachineState>; cmds: Cmd[] } {
  if (!s.card || s.card.phase === 'tucking') return { patch: {}, cmds: [] };
  return {
    patch: { card: { ...s.card, phase: 'tucking' }, cardAt: now },
    cmds: [{ c: 'card.tuck' }],
  };
}

/** The card behind the current loop state, if any. */
export function cardBehind(s: MachineState): Card | null {
  const l = s.loop;
  return l.s === 'member' || l.s === 'reviewing' || l.s === 'applying' || l.s === 'verdict'
    ? l.card
    : null;
}

const isServerKind = (o: ScanOutcome) =>
  o.kind === 'ok' || o.kind === 'heads_up' || o.kind === 'refused' || o.kind === 'queued';

/** A row for the recent list: what the server decided, and the one system verdict that may still resolve. */
export function recentRow(o: ScanOutcome, at: number): Recent | null {
  if (
    !(isServerKind(o) || o.reason === 'unconfirmed' || o.reason === 'still_unconfirmed') ||
    (o.local && o.kind === 'refused')
  )
    return null;
  return { scanId: o.scanId, at, outcome: o, undoable: o.kind === 'ok' && o.undoUntil !== null };
}

/** Adds `row` newest first, or replaces the unconfirmed row made at `replaceAt`. */
export function withRow(list: Recent[], row: Recent | null, replaceAt?: number): Recent[] {
  if (!row) return list;
  const i =
    replaceAt === undefined
      ? -1
      : list.findIndex(
          (r) =>
            r.at === replaceAt &&
            (r.outcome.reason === 'unconfirmed' || r.outcome.reason === 'still_unconfirmed'),
        );
  if (i < 0) return [row, ...list].slice(0, 20);
  return list.map((r, n) => (n === i ? { ...row, at: r.at } : r));
}

export interface VerdictOpts {
  input: ScanInput;
  card: Card | null;
  outcome: ScanOutcome;
  /** The loop already shows this input: replace the outcome and keep the card layer. */
  inPlace?: boolean;
  /** The camera was frozen while checking: resume it. */
  resumeCamera?: boolean;
  /** A read that arrived while the request was in flight. */
  next?: ScanInput | null;
  /** The recent row to replace (a late answer), by its time; otherwise a new row is added. */
  replaceRecentAt?: number;
}

/** Enters `verdict`: holds, ignore windows, counts, recent, and the commands of AC 4.1 in order. */
export function enterVerdict(s: MachineState, o: VerdictOpts, env: Env): Out {
  const { now } = env;
  const { outcome, input } = o;
  const posture = s.armed || s.posture === 'door' ? 'door' : 'desk';
  const view = presentOutcome(outcome, posture, {
    holdResults: s.prefs.holdResults,
    retryAfterMs: outcome.retryAfterMs,
  });
  const card = o.card ?? outcome.card;
  const settles =
    posture === 'desk' &&
    card !== null &&
    view.hold !== null &&
    outcome.reason !== 'rate_limited' &&
    (outcome.kind === 'ok' || outcome.kind === 'system');
  const closeAt = !settles && view.hold !== null ? now + view.hold : null;
  const settleAt = settles && view.hold !== null ? now + view.hold : null;

  let ignore = settleShown(s.ignore, now);
  if (outcome.kind === 'ok' || outcome.kind === 'queued')
    ignore = addIgnore(ignore, acceptedIgnore(input.sig, now));
  else if (outcome.kind === 'refused')
    ignore = addIgnore(ignore, refusedIgnore(input.sig, now, headlineOf(outcome.reason)));
  else if (outcome.kind === 'heads_up') ignore = addIgnore(ignore, shownIgnore(input.sig));

  const row = recentRow(outcome, now);
  const cmds: Cmd[] = [];
  if (o.resumeCamera && s.camera === 'live' && !s.pausedReason)
    cmds.push({ c: 'camera', op: 'resume' });
  if (view.tone) cmds.push({ c: 'sound', tone: view.tone });
  let layer: Partial<MachineState> = {};
  if (!o.inPlace) {
    const raised = raiseCard(s, 'result', outcome.scanId ?? input.id, now);
    layer = raised.patch;
    cmds.push(...raised.cmds);
  }
  if (view.beat) cmds.push({ c: 'beat', beat: view.beat });
  if (view.announcement)
    cmds.push({ c: 'announce', text: view.announcement, polite: view.region === 'status' });
  if (view.dock.focus) cmds.push({ c: 'focus', target: view.dock.focus });
  if (outcome.milestone) cmds.push({ c: 'celebrate' });

  const state: MachineState = {
    ...s,
    ...layer,
    loop: {
      s: 'verdict',
      input,
      card,
      outcome,
      since: now,
      closeAt,
      settleAt,
      openFrom: now + SCAN_TIMING.NEXT_SCAN_AFTER_VERDICT,
      next: o.next ?? null,
    },
    ignore,
    recent: withRow(s.recent, row, o.replaceRecentAt),
    counts:
      !outcome.local && outcome.counts.asOf >= (s.counts?.asOf ?? 0) ? outcome.counts : s.counts,
    armed: outcome.kind === 'ok' && s.armed && !s.armed.sticky ? null : s.armed,
    lastActivity: now,
  };
  return { state, cmds };
}
