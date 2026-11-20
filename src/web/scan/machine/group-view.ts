/** A bundle on a handheld: who is in, who is left, and the words for it. Pure, from the outcome alone. */
import { SCAN_GROUP_COPY } from '../../../shared/copy/scan-group.ts';
import type { ScanOutcome } from './types.ts';

export type PersonState = 'in' | 'pending' | 'already' | 'refused';
export interface GroupPerson {
  name: string;
  state: PersonState;
  /** Why a member was not let in: a scan reason. */
  reason?: string;
  /** The server's initials for this person; empty when this role may not read the name. */
  initials?: string;
}
export interface GroupView {
  people: GroupPerson[];
  /** In the group now, the group's size and who is not in yet. */
  inCount: number;
  total: number;
  remaining: number;
  /** "Anna's group", or "the group" with no name to use. */
  who: string;
  /** This answer is the result of Check in more. */
  done: boolean;
  /** People it checked in this time. */
  added: number;
  /** The scanned pass was already in when the group ran: it is the one scanned a moment ago. */
  leadIn: boolean;
}

const MAX_PEOPLE = 10;
const first = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

/** The bundle behind an ok or heads-up verdict, or null when there is none. */
export function groupView(o: ScanOutcome): GroupView | null {
  const lead = o.display?.identity.holder ?? o.card?.title ?? '';
  const name = first(lead);
  const who = name ? SCAN_GROUP_COPY.whose.replace('{name}', name) : SCAN_GROUP_COPY.theGroup;
  const g = o.group;
  if (g) {
    const leadIn = o.kind === 'ok' && g.members?.[0]?.state === 'already';
    const people = (g.members ?? []).slice(0, MAX_PEOPLE).map((m, i): GroupPerson => {
      const state: PersonState =
        m.state === 'done' || (i === 0 && leadIn)
          ? 'in'
          : m.state === 'already'
            ? 'already'
            : 'refused';
      return {
        name: first(m.name),
        state,
        ...(state === 'refused' && m.reason ? { reason: m.reason } : {}),
      };
    });
    const inCount = g.total - g.refused;
    return {
      people,
      inCount,
      total: g.total,
      remaining: g.refused,
      who,
      done: true,
      added: g.done,
      leadIn,
    };
  }
  const b = o.bundle;
  if (!b || b.size < 2) return null;
  const members = b.members?.slice(0, MAX_PEOPLE);
  // With the server's member list who is in is each person's own (the one just checked in is in),
  // and the counts follow the discs; without it the first `checkedIn` are.
  const isIn = (i: number): boolean =>
    members
      ? Boolean(members[i]?.checkedIn) || (i === 0 && o.kind === 'ok')
      : i < (b.checkedIn ?? 1);
  const inCount = members
    ? members.reduce((n, _, i) => n + (isIn(i) ? 1 : 0), 0)
    : Math.min(b.size, Math.max(1, b.checkedIn ?? 1));
  const people = Array.from({ length: Math.min(b.size, MAX_PEOPLE) }, (_, i): GroupPerson => {
    const m = members?.[i];
    const state: PersonState = isIn(i) ? 'in' : 'pending';
    return { name: i === 0 ? name : '', state, ...(m?.initials ? { initials: m.initials } : {}) };
  });
  return {
    people,
    inCount,
    total: b.size,
    remaining: b.size - inCount,
    who: name ? who : b.name || who,
    done: false,
    added: 0,
    leadIn: false,
  };
}

/** "1 of 4 in Anna's group". */
export const groupSub = (v: GroupView): string =>
  SCAN_GROUP_COPY.ofIn
    .replace('{n}', String(v.inCount))
    .replace('{total}', String(v.total))
    .replace('{who}', v.who);

/** "Checked in 3 more" after the group ran; the plain word before it. */
export const groupHeadline = (v: GroupView): string =>
  (v.leadIn ? SCAN_GROUP_COPY.checkedInMore : SCAN_GROUP_COPY.checkedInN).replace(
    '{n}',
    String(v.added),
  );

/** The dock's button: how many are left to check in, or null when nobody is. */
export const groupAction = (o: ScanOutcome): { n: number; label: string } | null => {
  if (o.kind !== 'ok' || o.group) return null;
  const v = groupView(o);
  return v && v.remaining > 0
    ? { n: v.remaining, label: SCAN_GROUP_COPY.checkInMore.replace('{n}', String(v.remaining)) }
    : null;
};
