import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScannerAcceptsSchema } from '../../../shared/contracts/scanners.ts';
import type { SqlValue } from '../../platform/db.ts';
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
  if (row.accepts === null)
    return { sql: parsedSettings.data.acceptAllTemplates ? '1' : '0', params: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(row.accepts);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1)
    return null;
  const parsed = ScannerAcceptsSchema.safeParse(raw);
  if (!parsed.success) return null;
  if ('eventId' in parsed.data)
    return {
      sql: `s.event_id=?/* scan-ephemeral-event-id */ AND EXISTS (
      SELECT 1 FROM scan_events event_scope WHERE event_scope.id=s.event_id
        AND event_scope.org_id=s.org_id AND event_scope.mode=s.mode AND event_scope.archived_at IS NULL)
      AND ((s.pass_id IS NULL AND s.template_id IS NULL) OR EXISTS (SELECT 1 FROM scan_event_templates et
        WHERE et.event_id=s.event_id AND et.template_id=s.template_id))`,
      params: [parsed.data.eventId],
    };
  return {
    sql: 's.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */))',
    params: [JSON.stringify([...new Set(parsed.data.templateIds)])],
  };
}

/** The ledger scans of the session's paired devices inside its scope, newest first. */
export function activitySelector(row: ScanningSessionRow): HistorySelector | null {
  const scope = activityScope(row);
  if (!scope) return null;
  return {
    where: `s.scanner_id IN (SELECT a.scanner_id FROM scanning_devices a
        JOIN scanners d ON d.id=a.scanner_id AND d.org_id=a.org_id AND d.mode=a.mode
        WHERE a.org_id=? AND a.session_id=?/* scan-ephemeral-session-id */ AND a.mode=?)
      AND (${scope.sql}) AND s.outcome IS NOT NULL AND ${scanLedgerScopeSql('s')}`,
    params: [row.org_id, row.id, row.mode, ...scope.params],
    limit: ACTIVITY_LIMIT,
  };
}
