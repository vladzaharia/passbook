/**
 * What the person record shows, decided from one outcome and what this operator may do. Pure, so
 * the rules (which band, which action is primary, what a locked action leads to) are tested without
 * a screen. The outcome is a scan's verdict, a desk card waiting for an action, or a pass opened
 * from a list; the record reads them the same way.
 */
import type { ScanRole } from '../../../../shared/contracts/scan.ts';
import type { ScanChip } from '../../../../shared/contracts/scan-display.ts';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { SCAN_COPY, scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { accessLines, directionPill, holdVerbs } from '../../machine/access-view.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { verdictLine } from '../../machine/verdict-lines.ts';
import { canAddPhoto } from '../../result/add-photo.tsx';
import { sessionTime } from '../../ui/session-time.ts';
import { mayNote, nextStepOf } from './record-facts.ts';

const R = OPERATOR_COPY.record;

/** Where the record was opened from: a scan, or a list row or an opened search hit. */
export type Source = 'scan' | 'open';

export interface Rights {
  role: ScanRole | null;
  photo: boolean;
  markOut: boolean;
}

/** The role acting here: the signed-in staff, the device's role without sign-in, or a manager for an admin. */
export function rightsOf(session: ScanSession): Rights {
  const scanner = session.scanner;
  const role: ScanRole | null =
    session.principal === 'admin'
      ? 'manager'
      : scanner
        ? scanner.settings.staffSignIn
          ? (session.staff?.role ?? null)
          : (scanner.settings.roleWithoutSignIn ?? null)
        : null;
  return {
    role,
    photo: canAddPhoto(session),
    markOut: role === 'desk' || role === 'manager',
  };
}

export type Tone = 'ok' | 'hu' | 'no' | 'sys' | 'preview';

export interface Band {
  tone: Tone;
  title: string;
  sub: string | null;
  /** The pill that leads the sub: what the scan did. */
  pill: 'in' | 'out' | null;
  at: number | null;
}

/** The headline and sub of a verdict, as the result card words them; one source of words. */
export function bandOf(
  o: ScanOutcome,
  source: Source,
  opts: { now: number; desk: boolean; timeZone?: string | undefined },
): Band | null {
  if (o.kind === 'ready')
    return source === 'scan'
      ? { tone: 'preview', title: R.choose, sub: null, pill: null, at: null }
      : null;
  const held = accessLines(o, opts.now);
  const line = verdictLine(o, opts.now, { desk: opts.desk });
  const ok = o.kind === 'ok' || o.kind === 'queued';
  const noExit =
    o.reason === 'not_accepted' && o.checkIn?.direction === 'out' && o.checkIn.mode !== 'in_out';
  const noReentry =
    o.reason === 'already_done' && o.checkIn?.mode === 'in_out' && !o.checkIn.inside;
  let title: string;
  if (noExit) title = 'Check-out not allowed';
  else if (noReentry) title = 'No re-entry';
  else if (o.action?.id === 'undo') title = 'Undone';
  else if (held) title = held.title;
  else if (ok)
    title =
      o.action?.kind === 'check_in'
        ? o.checkIn?.direction === 'out'
          ? 'Checked out'
          : SCAN_COPY.verdict.checkedIn
        : (o.action?.label ?? 'Done');
  else title = line?.headline ?? R.choose;
  const sub = noExit
    ? SCAN_COPY.verdict.noExitSub
    : noReentry
      ? SCAN_COPY.verdict.noReentrySub
      : o.kind === 'queued'
        ? R.saved
        : (held?.sub ?? line?.sub ?? null);
  const tone: Tone = ok ? 'ok' : o.kind === 'heads_up' ? 'hu' : o.kind === 'refused' ? 'no' : 'sys';
  return { tone, title, sub, pill: directionPill(o), at: o.at };
}

export interface Presence {
  state: 'in' | 'out' | 'none';
  /** "since 6:41 PM · Gym floor", or nothing. */
  line: string | null;
}

/** Where the person is now, from the place's count when there is one, else the door's state. Null: not tracked. */
export function presenceOf(o: ScanOutcome, timeZone?: string): Presence | null {
  const card = o.card;
  const occ = o.occupancy ?? card?.occupancy ?? null;
  const door = card?.door ?? null;
  const entered = o.checkIn?.enteredAt ?? card?.checkIn?.enteredAt ?? null;
  const known: 'in' | 'out' | null =
    occ?.state ??
    door?.state ??
    (o.kind === 'ok' && o.checkIn ? (o.checkIn.inside ? 'in' : 'out') : null);
  if (!known) return door ? { state: 'none', line: null } : null;
  const since = occ?.since ?? (known === 'in' ? (entered ?? o.at) : null);
  const parts = [
    since ? scanLine(R.since, { time: sessionTime(since, timeZone) }) : null,
    occ?.place.name ?? null,
  ].filter(Boolean);
  return { state: known, line: parts.length ? parts.join(' · ') : null };
}

/** The screen to paint: a verdict's own, or the desk card's `ready` one. */
export const displayOf = (o: ScanOutcome) => o.display ?? o.card?.display ?? null;

export interface Identity {
  name: string;
  meta: string | null;
  chips: ScanChip[];
  photoUrl: string | null;
  photoAlt: string;
}

const chip = (id: string, text: string, tone: ScanChip['tone']): ScanChip => ({
  id,
  text,
  tone,
  icon: null,
});

/** Who: a denied verdict shows the name and the pass type only, no photo or chips. */
export function identityOf(o: ScanOutcome): Identity | null {
  const d = displayOf(o);
  const card = o.card;
  const name = d?.identity.holder || card?.title || o.template?.name;
  if (!name) return null;
  const type = o.template?.name ?? card?.template.name ?? null;
  const denied = o.kind === 'refused';
  const meta = denied
    ? type && type !== name
      ? type
      : null
    : (d?.header.meta ?? ([type, card?.subtitle].filter(Boolean).join(' · ') || null));
  const chips: ScanChip[] = [];
  if (!denied) {
    if (type) chips.push(chip('type', type, 'teal'));
    for (const c of d?.header.chips ?? []) chips.push(c);
    for (const f of [...o.flags, ...(card?.flags.map((x) => x.label) ?? [])])
      if (!chips.some((c) => c.text === f)) chips.push(chip(`flag-${f}`, f, 'gold'));
  }
  const status = card?.status;
  if (status && status !== 'active')
    chips.push(chip('status', status[0]?.toUpperCase() + status.slice(1), 'gold'));
  if (denied && o.reason === 'voided') chips.push(chip('voided', 'Voided', 'neutral'));
  return {
    name,
    meta,
    chips,
    photoUrl: denied ? null : (d?.identity.photo?.url ?? null),
    photoAlt: d?.identity.photo?.alt ?? '',
  };
}

export type Run =
  | { t: 'pick'; actionId: string }
  | { t: 'check-in'; actionId: string }
  | { t: 'open'; passId: string }
  | { t: 'group' }
  | { t: 'override'; actionId: string }
  | { t: 'turn'; direction: 'in' | 'out' }
  | { t: 'ask' }
  | { t: 'mark-out' }
  | { t: 'show-pass'; passId: string }
  | { t: 'look-up'; q: string }
  | { t: 'photo' }
  | { t: 'note' };

export interface Act {
  id: string;
  label: string;
  run: Run;
  /** The key that runs it from the record. */
  key?: 'Enter' | 'O' | 'N' | 'P';
  /** Kept in its place with a lock: a role cannot, a Manager's PIN can. */
  lock?: 'role' | 'approval' | 'max';
  icon:
    | 'check'
    | 'family'
    | 'out'
    | 'shield'
    | 'photo'
    | 'note'
    | 'value'
    | 'again'
    | 'tap'
    | 'pass'
    | 'search';
}

export interface Actions {
  primary: Act | null;
  others: Act[];
  /** One line under the bar: what the primary costs, or why it is not offered. */
  reason: string | null;
  viewOnly: boolean;
}

export interface ActionFacts {
  /** Opened from a list: card actions that are not a check-in open the desk panel first. */
  source: Source;
  rights: Rights;
  /** The pass this record is of, and its holder's name: what Open pass and Look up use. */
  passId: string | null;
  name: string | null;
  /** The record has no photo and this device may add one. */
  addPhoto: boolean;
  /** Mark out is on offer: the person is inside a place here. */
  markOut: boolean;
}

/** Everything the bar offers, in order, with the primary chosen. The server still decides each one. */
export function actionsOf(o: ScanOutcome, f: ActionFacts): Actions {
  const card = o.card;
  if (card && viewOnlyCard(card))
    return { primary: null, others: [], reason: null, viewOnly: true };
  const acts: Act[] = [];
  let primary: Act | null = null;
  let reason: string | null = null;
  if (o.kind === 'ready' && card) {
    const checkIn = card.actions.find((a) => a.kind === 'check_in' && a.available && !a.lock);
    for (const a of card.actions) {
      const usable = a.available || a.lock === 'approval';
      const act: Act = {
        id: a.id,
        label: a.label,
        icon: a.kind === 'check_in' ? 'check' : 'value',
        run:
          f.source === 'scan'
            ? { t: 'pick', actionId: a.id }
            : a.kind === 'check_in'
              ? { t: 'check-in', actionId: a.id }
              : { t: 'open', passId: card.passId },
        ...(a.lock ? { lock: a.lock } : !a.available ? { lock: 'max' as const } : {}),
      };
      if (a.lock === 'approval') act.icon = 'shield';
      if (!primary && usable && (checkIn ? a === checkIn : true)) primary = act;
      else acts.push(act);
    }
    const left = o.access?.visits ?? card.access?.visits ?? null;
    if (primary && left?.limit != null && primary.icon === 'check')
      reason = scanLine(left.limit - left.used > 1 ? R.usesVisit : R.usesLast, {
        left: left.limit - left.used - 1,
      });
  } else if (o.kind === 'heads_up' || o.kind === 'refused') {
    if (o.reason === 'needs_approval' && o.approvals) {
      primary = { id: 'ask', label: R.askManager, icon: 'shield', run: { t: 'ask' } };
    } else {
      const verb = holdVerbs(o)[0];
      const check = (o.reason === 'check_required' || o.reason === 'offline_decide') && o.action;
      if (verb?.kind === 'turn')
        primary = {
          id: 'turn',
          label: verb.label,
          icon: 'tap',
          run: { t: 'turn', direction: verb.direction },
        };
      else if (verb || check)
        primary = {
          id: 'let-in',
          label: verb?.label ?? (check ? check.label : R.letIn),
          icon: 'again',
          run: { t: 'override', actionId: o.action?.id ?? '' },
        };
    }
  } else if (o.kind === 'ok' && o.bundle && (o.bundle.checkedIn ?? 0) < o.bundle.size && !o.group) {
    const n = o.bundle.size - (o.bundle.checkedIn ?? 0);
    primary = {
      id: 'family',
      label: scanLine(R.family, { n }),
      icon: 'family',
      run: { t: 'group' },
    };
  }
  const denied = o.kind === 'refused' || o.kind === 'heads_up';
  if (denied) {
    const open: Act | null = f.passId
      ? {
          id: 'show-pass',
          label: R.openPass,
          icon: 'pass',
          run: { t: 'show-pass', passId: f.passId },
        }
      : null;
    if (open && !primary) primary = open;
    else if (open) acts.unshift(open);
    acts.splice(open && primary !== open ? 1 : 0, 0, {
      id: 'look-up',
      label: R.lookUp,
      icon: 'search',
      run: { t: 'look-up', q: f.name ?? '' },
    });
    reason ??= nextStepOf(o);
  }
  if (f.markOut && f.rights.markOut)
    acts.push({ id: 'out', label: R.markOut, icon: 'out', key: 'O', run: { t: 'mark-out' } });
  if (f.passId && mayNote(f.rights.role))
    acts.push({ id: 'note', label: R.note, icon: 'note', key: 'N', run: { t: 'note' } });
  if (f.addPhoto)
    acts.push({ id: 'photo', label: R.photo, icon: 'photo', key: 'P', run: { t: 'photo' } });
  if (primary) primary = { ...primary, key: 'Enter' };
  return { primary, others: acts.slice(0, 3), reason, viewOnly: false };
}

/** Every action is locked by role: the server has made this card for reading. */
function viewOnlyCard(card: NonNullable<ScanOutcome['card']>): boolean {
  return card.actions.length > 0 && card.actions.every((a) => !a.available && a.lock === 'role');
}
