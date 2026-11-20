import type { HistoryFilter } from '../../../shared/contracts/scan-history.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import type { HistorySelector } from './repo-history-rows.ts';
import { HISTORICAL_SCOPE_SQL } from './repo-scan-history.ts';

export interface PassHistoryQuery {
  passId: string;
  templateId: string;
  since: number;
  filter: HistoryFilter;
  /** Only scans before this (time, id): the previous page's last line. */
  before?: { at: number; id: string };
  limit: number;
}

/** A visit is a check-in, a check-out or a refusal; a change is a value action. */
const KIND_SQL: Record<HistoryFilter, string> = {
  all: '1',
  visits: "(s.action_kind IS NULL OR s.action_kind = 'check_in')",
  changes: "s.action_kind IN ('add', 'take', 'set', 'use_up')",
};

/**
 * One pass's scans, newest first: the ledger scope (the tenant comes from the fence), this pass and
 * template, the window, and the event the actor is bound to. An undo's own row is no line: the scan it
 * undid shows as undone.
 */
export function passHistorySelector(actor: ScanActor, q: PassHistoryQuery): HistorySelector {
  const clauses = [
    's.pass_id = ?',
    's.template_id = ?',
    's.at >= ?',
    's.outcome IS NOT NULL',
    "s.action_kind IS NOT 'undo'",
    KIND_SQL[q.filter],
    HISTORICAL_SCOPE_SQL,
  ];
  const params: SqlValue[] = [q.passId, q.templateId, q.since];
  if (actor.event) {
    clauses.push('s.event_id IS ?');
    params.push(actor.event.id);
  }
  if (q.before) {
    clauses.push('(s.at < ? OR (s.at = ? AND s.id < ?))');
    params.push(q.before.at, q.before.at, q.before.id);
  }
  return { where: clauses.join(' AND '), params, limit: q.limit };
}
