import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import type { ResolvedOutcome } from '../machine/access-events.ts';
import { savedCount } from '../machine/derive.ts';
import type { Recent, ScanState } from '../machine/types.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import type { StripEntry } from './last-scan-strip.tsx';
import { sessionTime } from './session-time.ts';

/** The dock strip for the newest scan. A tracked place says which way and where: `In · Gym · 6:41 PM`. */
export function stripOf(
  last: Recent | undefined,
  undoable: boolean,
  now: number = last?.at ?? 0,
): StripEntry | null {
  if (!last) return null;
  const o = last.outcome;
  const time = sessionTime(last.at);
  const staff = (o as ResolvedOutcome).resolvedBy;
  const where = o.occupancy && o.kind === 'ok' && o.action?.id !== 'undo' ? o.occupancy : null;
  const meta = staff
    ? scanLine(SCAN_COPY.verdict.letInByStrip, {
        staff,
        scanner: o.occupancy?.via ?? '',
      }).replace(/ at $/, '')
    : where
      ? `${SCAN_COPY.direction[where.direction]} · ${where.place.name} · ${time}`
      : time;
  const who = o.display?.identity.holder ?? o.card?.title;
  const said = o.kind === 'ok' ? null : (verdictLine(o, now)?.headline ?? null);
  return {
    kind: o.kind === 'ok' || o.kind === 'heads_up' || o.kind === 'refused' ? o.kind : 'system',
    title: who ?? said ?? o.action?.label ?? 'Scan',
    meta: who && said ? `${said} · ${meta}` : meta,
    undoable,
  };
}

/** The dock strip: the newest scan, or while offline what still works and what is saved. */
export function dockStrip(
  s: Pick<ScanState, 'online' | 'queue' | 'unsure'>,
  last: Recent | undefined,
  undoable: boolean,
  now: number,
): StripEntry | null {
  if (s.online) return stripOf(last, undoable, now);
  const n = savedCount(s);
  return {
    kind: 'system',
    title: SCAN_COPY.offline.strip,
    meta: n > 0 ? scanLine(SCAN_COPY.offline.saved, { n }) : '',
  };
}

export { savedCount };
