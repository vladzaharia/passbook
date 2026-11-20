/**
 * `present()`: the one table of presentation rules (AC 3.3 with SA 7.5). It turns an outcome and a
 * posture into a `Presentation`; `viewOf` does the same for a whole state, plus the buddy's view.
 * Layers and phases only: no geometry, no colour (that is stream UI's).
 */
import { SCAN_TIMING } from '../timing.ts';
import { accessBeatOf, accessLines } from './access-view.ts';
import { groupAction, groupHeadline, groupSub, groupView } from './group-view.ts';
import { headlineOf } from './outcome.ts';
import type {
  BuddyBeat,
  BuddyView,
  Card,
  Presentation,
  ScanOutcome,
  ScanState,
  Tone,
} from './types.ts';

export interface PresentOpts {
  holdResults: boolean;
  /** For `rate_limited`: how long the verdict holds. */
  retryAfterMs?: number;
}

/** The buddy's pose also carries `rummage`: a loop while a request is pending (BM M8). */
export type ScanBuddyView = Omit<BuddyView, 'pose'> & { pose: BuddyView['pose'] | 'rummage' };
export type ScanView = Presentation & { buddy: ScanBuddyView };

const HOLD_REASONS = new Set(['ambiguous']);
/** A bundle with people left: the dock offers Check in more for this long (handheld design 5). */
export const GROUP_HOLD = 6000;

/** An available `take` with a reward label that the card's values now cover (SA 7.5). */
export function promotedAction(card: Card | null | undefined) {
  if (!card) return null;
  return (
    card.actions.find((a) => {
      if (a.kind !== 'take' || !a.available || !a.rewardLabel) return false;
      const need = a.amount && 'fixed' in a.amount ? a.amount.fixed : null;
      return card.values.some((v) => {
        const have = typeof v.after === 'number' ? v.after : null;
        const goal = need ?? v.goal;
        return have !== null && goal !== null && have >= goal;
      });
    }) ?? null
  );
}

function beatFor(o: ScanOutcome): BuddyBeat | null {
  if (o.milestone || (o.group && o.group.refused === 0)) return 'fan';
  switch (o.kind) {
    case 'ok': {
      const held = accessBeatOf(o);
      if (held) return held;
      const a = o.action?.kind;
      const v = o.value;
      if (a === 'add')
        return v?.format === 'currency' ? 'coins' : v?.goal != null ? 'stamp' : 'sparkle';
      if (a === 'take')
        return v?.format === 'currency' ? 'coins' : v?.goal != null ? 'punch' : 'sparkle';
      if (a === 'set') return 'nod';
      if (a === 'use_up') return 'punch';
      return 'hop';
    }
    case 'queued':
      return 'stash';
    case 'heads_up':
      return o.reason === 'not_inside' && o.occupancy?.turnaround !== 'in' ? 'tilt' : 'wrist';
    case 'refused':
      return 'shake';
    case 'system':
      if (o.reason === 'server') return 'plug';
      if (o.reason === 'rate_limited') return 'wait';
      return 'cloud';
    case 'ready':
      return 'look';
  }
}

export function announcementFor(o: ScanOutcome): string | null {
  if (o.kind === 'ready') return o.card?.title ?? null;
  if (o.kind === 'ok' || o.kind === 'queued') {
    const who = o.card?.title ?? o.display?.identity.holder ?? null;
    const what =
      o.kind === 'queued'
        ? 'Saved offline'
        : (accessLines(o, o.at ?? 0)?.title ?? o.action?.label ?? 'Done');
    const group = o.kind === 'ok' ? groupView(o) : null;
    const said = group?.done ? groupHeadline(group) : what;
    const line = who ? `${said}. ${who}` : said;
    return group ? `${line}. ${groupSub(group)}` : line;
  }
  return headlineOf(o.reason);
}

function holdFor(o: ScanOutcome, posture: 'door' | 'desk', opts: PresentOpts): number | null {
  if (opts.holdResults) return null;
  switch (o.kind) {
    case 'ok':
    case 'queued':
      // A bundle with people left to check in waits for the button; a group with a refusal to read stays too.
      if (o.bundle && !o.group) return groupAction(o) ? GROUP_HOLD : SCAN_TIMING.OK_HOLD;
      return o.group && o.group.refused > 0 ? SCAN_TIMING.REFUSED_HOLD : SCAN_TIMING.OK_HOLD;
    case 'refused':
      return posture === 'desk' || HOLD_REASONS.has(String(o.reason))
        ? null
        : SCAN_TIMING.REFUSED_HOLD;
    case 'system':
      if (o.reason === 'rate_limited')
        return opts.retryAfterMs ?? o.retryAfterMs ?? SCAN_TIMING.OK_HOLD;
      return posture === 'desk' ? SCAN_TIMING.OK_HOLD : null;
    default:
      return null;
  }
}

export function presentOutcome(
  o: ScanOutcome,
  posture: 'door' | 'desk',
  opts: PresentOpts,
): Presentation {
  const base = {
    dim: false,
    hold: holdFor(o, posture, opts),
    beat: beatFor(o),
    announcement: announcementFor(o),
    card: { kind: 'result' as const, rise: true },
  };
  const undo = o.scanId && o.undoUntil ? ('undo' as const) : null;
  switch (o.kind) {
    case 'ok':
    case 'queued': {
      const promoted = o.kind === 'ok' && posture === 'desk' ? promotedAction(o.card) : null;
      const tone: Tone = o.milestone ? 'reward' : 'ok';
      return {
        ...base,
        tint: 'green',
        tone,
        region: 'status',
        dock: {
          primary: promoted ? 'redeem' : posture === 'desk' ? 'done' : null,
          secondary: o.kind === 'ok' ? undo : null,
          focus: null,
        },
      };
    }
    case 'heads_up':
      return {
        ...base,
        tint: 'amber',
        tone: 'heads_up',
        region: 'status',
        dock: {
          primary: o.reason === 'needs_approval' && o.approvals ? 'approve' : 'done',
          secondary: null,
          focus: 'done',
        },
      };
    case 'refused':
      return {
        ...base,
        tint: 'red',
        tone: 'refused',
        region: 'alert',
        dock: { primary: 'done', secondary: null, focus: null },
      };
    case 'system':
      return {
        ...base,
        tint: 'slate',
        tone: 'system',
        region: 'alert',
        dock: { primary: 'done', secondary: null, focus: 'done' },
      };
    case 'ready':
      return {
        ...base,
        tint: 'none',
        dim: true,
        hold: null,
        tone: null,
        region: 'status',
        card: { kind: 'panel', rise: true },
        dock: { primary: 'commit', secondary: 'cancel', focus: null },
      };
  }
}

const NEUTRAL: Presentation = {
  tint: 'none',
  hold: null,
  dim: false,
  dock: { primary: null, secondary: null, focus: null },
  card: null,
  tone: null,
  beat: null,
  region: 'status',
  announcement: null,
};

/** The buddy's face for a verdict: it backs the colour and the word. */
export function moodOf(kind: ScanOutcome['kind']): BuddyView['mood'] {
  switch (kind) {
    case 'ok':
      return 'happy';
    case 'heads_up':
      return 'curious';
    case 'refused':
    case 'system':
      return 'sad';
    default:
      return 'neutral';
  }
}

function mood(state: ScanState): BuddyView['mood'] {
  const l = state.loop;
  return l.s === 'verdict' ? moodOf(l.outcome.kind) : 'neutral';
}

function pose(state: ScanState): ScanBuddyView['pose'] {
  const l = state.loop;
  if (l.s === 'verdict') return l.outcome.kind === 'system' ? 'sorry' : 'rest';
  if (l.s === 'checking' || l.s === 'applying') return l.slow ? 'rummage' : 'aim';
  if (l.s === 'ready') return state.camera === 'live' ? 'aim' : 'rest';
  return 'rest';
}

/** What the whole state looks like. `shown` is the store's delayed beat (BEAT_DELAY); without it the beat is immediate. */
export function viewOf(
  state: ScanState,
  shown?: { beat: BuddyBeat | null; key: string },
): ScanView {
  const l = state.loop;
  const layer = state.card;
  const card = layer ? { kind: layer.kind, rise: layer.phase === 'rising' } : null;
  let p: Presentation = { ...NEUTRAL, card };
  if (l.s === 'verdict') {
    const posture = state.armed || state.posture === 'door' ? 'door' : 'desk';
    const full = presentOutcome(l.outcome, posture, {
      holdResults: state.prefs.holdResults,
      retryAfterMs: l.outcome.retryAfterMs,
    });
    const end = l.closeAt ?? l.settleAt;
    p = { ...full, hold: end === null ? null : end - l.since, card };
  } else if (l.s === 'member') {
    const band = l.band;
    p = {
      ...NEUTRAL,
      card,
      dim: true,
      announcement: null,
      dock: l.picker
        ? { primary: 'commit', secondary: 'cancel', focus: null }
        : {
            primary: promotedAction(l.card) ? 'redeem' : 'done',
            secondary: band?.scanId && band.undoUntil ? 'undo' : null,
            focus: null,
          },
    };
  } else if (l.s === 'reviewing') {
    p = {
      ...NEUTRAL,
      card,
      dim: true,
      dock: { primary: 'commit', secondary: 'back', focus: null },
    };
  } else if (l.s === 'applying') {
    p = { ...NEUTRAL, card, dim: true, dock: { primary: 'commit', secondary: null, focus: null } };
  }
  const key = l.s === 'verdict' ? l.input.id : l.s === 'member' ? l.input.id : '';
  return {
    ...p,
    buddy: {
      pose: pose(state),
      mood: mood(state),
      beat: shown ? shown.beat : p.beat,
      key: shown ? shown.key : key,
      card: layer && layer.phase !== 'tucking' ? 'in' : 'out',
    },
  };
}
