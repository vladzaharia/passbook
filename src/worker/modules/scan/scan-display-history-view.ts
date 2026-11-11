import type { Json } from '../../../passkit/types.ts';
import type { ScanActor } from './actor.ts';
import { localDay, localDayStart } from './counts.ts';

export interface DisplayRow {
  id: string;
  at: number;
  where: string;
  label: string;
}

export interface HistoryScope {
  orgId: string;
  mode: ScanActor['mode'];
  credentialKeysetCommitment: string;
  passId: string;
  templateId: string;
  eventId: string | null;
  timeZone: string;
  role: ScanActor['role'];
}

export function boundaries(now: number, timeZone: string) {
  const today = localDayStart(now, timeZone);
  const [year = 1970, month = 1, day = 1] = localDay(now, timeZone).split('-').map(Number);
  const calendarStart = (m: number, d: number) =>
    localDayStart(Date.UTC(year, m - 1, d, 12), timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    today,
    week: calendarStart(month, day - ((weekday + 6) % 7)),
    month: calendarStart(month, 1),
    year: calendarStart(1, 1),
  };
}

interface GenericHistory {
  scans: { total: number; today: number };
}

/** Generic scan counts carry no action, source or per-scan disclosure. */
export function genericHistory(row: Record<string, unknown> | undefined): GenericHistory | null {
  if (
    !row ||
    typeof row.n !== 'number' ||
    !Number.isSafeInteger(row.n) ||
    row.n < 0 ||
    typeof row.today !== 'number' ||
    !Number.isSafeInteger(row.today) ||
    row.today < 0 ||
    row.today > row.n
  )
    return null;
  return { scans: { total: row.n, today: row.today } };
}

export function render(
  rows: readonly DisplayRow[],
  topIds: readonly string[],
  verified: ReadonlySet<string>,
  generic: GenericHistory,
  complete: boolean,
  now: number,
  timeZone: string,
): Json {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const entries = topIds.flatMap((id) => {
    const row = byId.get(id);
    return row && verified.has(id) ? [{ at: row.at, where: row.where, label: row.label }] : [];
  });
  const first = topIds[0];
  const latest = first && verified.has(first) ? byId.get(first) : undefined;
  const list: Record<string, Json> = { scans: entries };
  const result: Record<string, Json> = { scans: generic.scans, list };
  if (latest)
    result.lastScan = {
      at: latest.at,
      where: latest.where,
      label: latest.label,
      action: latest.label,
    };
  else if (generic.scans.total === 0) result.lastScan = null;
  if (complete) {
    const start = boundaries(now, timeZone);
    const count = (from: number) => rows.filter((row) => row.at >= from).length;
    result.visits = {
      today: count(start.today),
      week: count(start.week),
      month: count(start.month),
      year: count(start.year),
      total: rows.length,
    };
    result.lastVisit = latest ? { at: latest.at, where: latest.where, label: latest.label } : null;
    list.visits = entries;
  }
  return result;
}
