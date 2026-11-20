import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import type { ResolvedOutcome } from '../machine/access-events.ts';
import { savedCount } from '../machine/derive.ts';
import { groupHeadline, groupView } from '../machine/group-view.ts';
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
  const group = o.kind === 'ok' && o.group ? groupView(o) : null;
  const meta = group
    ? `${groupHeadline(group)} · ${time}`
    : staff
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
    kind:
      o.kind === 'ok' || o.kind === 'queued'
        ? 'ok'
        : o.kind === 'heads_up' || o.kind === 'refused'
          ? o.kind
          : 'system',
    title: who ?? said ?? o.action?.label ?? 'Scan',
    meta: who && said ? `${said} · ${meta}` : meta,
    undoable,
  };
}

/** The dock strip: the newest scan, or while offline what still works and what is saved. */
export function dockStrip(
  s: Pick<ScanState, 'online' | 'queue' | 'unsure' | 'offline'>,
  last: Recent | undefined,
  undoable: boolean,
  now: number,
  /** A handheld's strip: offline with scans saved, it is the queue line, and View opens the queue. */
  handheld?: { since: number | null },
): StripEntry | null {
  if (s.online) return stripOf(last, undoable, now);
  const n = savedCount(s);
  if (handheld && n > 0) {
    const q = SCAN_HANDHELD_COPY.queue;
    const listAt = s.offline.mode === 'list' ? s.offline.listAt : null;
    const meta = [
      handheld.since !== null ? scanLine(q.since, { time: sessionTime(handheld.since) }) : null,
      listAt !== null ? scanLine(q.list, { time: sessionTime(listAt) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return { kind: 'system', icon: 'offline', title: scanLine(q.waiting, { n }), meta, view: true };
  }
  return {
    kind: 'system',
    title: s.offline.mode === 'stop' ? SCAN_COPY.offline.strip : SCAN_COPY.offline.stripSaving,
    meta: n > 0 ? scanLine(SCAN_COPY.offline.saved, { n }) : '',
  };
}

export { savedCount };
