import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type { SqlValue } from '../../platform/db.ts';
import { storedAdmits } from './admits.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import type { HistorySelector } from './repo-history-rows.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';

/** The page of a session's activity. */
export const ACTIVITY_LIMIT = 20;

type Predicate = { sql: string; params: readonly SqlValue[] };

/** Only scans in the originally selected session scope are candidates. */
function activityScope(row: ScanningSessionRow): Predicate | null {
  let settings: unknown;
  try {
    settings = JSON.parse(row.settings);
  } catch {
    return null;
  }
  const parsedSettings = ScannerSettingsSchema.safeParse(settings);
  if (!parsedSettings.success) return null;
  const admits = storedAdmits(row.accepts);
  if (admits === null)
    return { sql: parsedSettings.data.acceptAllTemplates ? '1' : '0', params: [] };
  if (!admits) return null;
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (admits.templateIds.length) {
    parts.push('s.template_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(admits.templateIds));
  }
  for (const eventId of admits.eventIds) {
    // The `+` keeps the planner on the devices' scans, not the whole event's.
    parts.push(`+s.event_id=? AND EXISTS (
      SELECT 1 FROM scan_events event_scope WHERE event_scope.id=s.event_id
        AND event_scope.org_id=s.org_id AND event_scope.mode=s.mode AND event_scope.archived_at IS NULL)
      AND ((s.pass_id IS NULL AND s.template_id IS NULL) OR EXISTS (SELECT 1 FROM scan_event_templates et
        WHERE et.event_id=s.event_id AND et.template_id=s.template_id))`);
    params.push(eventId);
  }
  return { sql: parts.map((part) => `(${part})`).join(' OR '), params };
}

/** The ledger scans of the session's paired devices inside its scope, newest first. */
export function activitySelector(row: ScanningSessionRow): HistorySelector | null {
  const scope = activityScope(row);
  if (!scope) return null;
  return {
    where: `s.scanner_id IN (SELECT a.scanner_id FROM scanning_devices a
        JOIN scanners d ON d.id=a.scanner_id AND d.org_id=a.org_id AND d.mode=a.mode
        WHERE a.org_id=? AND a.session_id=? AND a.mode=?)
      AND (${scope.sql}) AND s.outcome IS NOT NULL AND ${scanLedgerScopeSql('s')}`,
    params: [row.org_id, row.id, row.mode, ...scope.params],
    limit: ACTIVITY_LIMIT,
  };
}
