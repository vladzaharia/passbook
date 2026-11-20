import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatDay, formatWeekdayTime } from '../../../lib/format.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { sessionTime } from '../../ui/session-time.ts';

/**
 * Staff notes: Desk and above on a paired scan device, never a terminal or a console, and not while
 * the session is paused or closed. The server holds the same line.
 */
export function canNote(session: ScanSession, role: 'door' | 'desk' | 'manager' | null): boolean {
  const scanner = session.scanner;
  if (session.principal !== 'scanner' || !scanner) return false;
  if (scanner.kind === 'terminal' || scanner.deviceRole !== 'scan') return false;
  const live = session.workspace?.session;
  if (live && (live.status !== 'active' || !live.window?.open)) return false;
  return role === 'desk' || role === 'manager';
}

const R = OPERATOR_COPY.record;

/** What the operator does next after a refusal or a hold: from the reason, never a dead end. */
export function nextStepOf(o: ScanOutcome): string {
  if (o.reason === 'needs_approval') return R.needsManager;
  const next = R.next as Record<string, string>;
  return (o.reason && next[o.reason]) || R.next.other;
}

export interface Fact {
  label: string;
  value: string;
}

/** Why, in the pass's own terms: plan, visits used, validity, when it opens, the last time in. */
export function factsOf(o: ScanOutcome, timeZone?: string): Fact[] {
  const a = o.access ?? o.card?.access ?? null;
  const out: Fact[] = [];
  const F = R.facts;
  if (a?.plan) out.push({ label: F.plan, value: a.plan.label });
  if (a?.visits)
    out.push({
      label: F.visits,
      value: scanLine(a.visits.limit == null ? R.visitsOpen : R.visitsUsed, {
        used: a.visits.used,
        limit: a.visits.limit ?? 0,
      }),
    });
  const until = o.card?.validUntil ?? o.checkIn?.validUntil ?? null;
  if (until) out.push({ label: F.until, value: formatDay(until) });
  if (a?.nextOpenAt)
    out.push({ label: F.opens, value: formatWeekdayTime(a.nextOpenAt, a.timeZone) });
  if (o.previous)
    out.push({
      label: F.last,
      value: [sessionTime(o.previous.at, timeZone), o.previous.scannerName]
        .filter(Boolean)
        .join(' · '),
    });
  return out.slice(0, 4);
}

export interface BundleMember {
  initials: string;
  checkedIn: boolean;
  refusedReason?: string;
}

/** The bundle's members when the server sends them (`members`), else null: the counts alone then. */
export function membersOf(bundle: unknown): BundleMember[] | null {
  const m = (bundle as { members?: unknown } | null)?.members;
  if (!Array.isArray(m) || m.length === 0) return null;
  return m
    .filter((x): x is BundleMember => typeof x?.initials === 'string')
    .map((x) => ({
      initials: x.initials,
      checkedIn: Boolean(x.checkedIn),
      ...(x.refusedReason ? { refusedReason: String(x.refusedReason) } : {}),
    }));
}

/** The place a Mark out names: where the pass is counted as inside, else nothing. */
export function markOutPlace(o: ScanOutcome): string | null {
  const occ = o.occupancy ?? o.card?.occupancy;
  return occ?.state === 'in' ? `${occ.place.kind}:${occ.place.id}` : null;
}
