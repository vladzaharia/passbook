import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import { ScannerAcceptsSchema } from '../../../shared/contracts/scanners.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import {
  scanLedgerCommonScopeSql,
  scanLedgerPassOrRetentionCandidateSql,
} from './repo-feed-scope.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { packScanPredicate } from './repo-secret-binds.ts';
import type { SessionCountAuthority } from './scanning-session-dto.ts';

export interface ActivityCandidate {
  id: string;
  at: number;
  deviceId: string;
  deviceName: string;
  passId: string | null;
  eventId: string | null;
  templateId: string | null;
  outcome: 'ok' | 'heads_up' | 'refused' | 'undone';
  direction: 'in' | 'out' | null;
  serial: string | null;
  scanCode: string | null;
  barcodeHash: string | null;
  lookupHash: string | null;
  barcodeMessage: string | null;
  lookupValue: string | null;
}

export type ActivityReadRow = { [K in keyof ActivityCandidate]: ActivityCandidate[K] | null } & {
  authorized: number;
};

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

/** Activity selection uses this exact actor and parent. */
export function activityReadPlan(
  db: D1Database,
  row: ScanningSessionRow,
  authority: SessionCountAuthority,
  now: number,
): D1PreparedStatement | null {
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id)
  )
    return null;
  const original = authority.guardAt(now);
  const scope = activityScope(row);
  // The session's status, accepts, settings and time zone move its config epoch; name, the org's
  // display name and updated_at are labels, not authority.
  const parent = packScanPredicate(
    `EXISTS (
    SELECT 1 FROM scanning_sessions target
    WHERE target.id=?/* scan-ephemeral-session-id */ AND target.org_id=? AND target.mode=?
      AND target.config_epoch=?)`,
    [row.id, row.org_id, row.mode, row.config_epoch],
    'activity_parent_snapshot',
  );
  if (!original || !scope || !parent) return null;
  const guard = {
    sql: `(${original.sql}) AND (${parent.sql})`,
    params: [...original.params, ...parent.params],
  };
  // The SELECT also binds the scope, organization, session and mode.
  if (guard.params.length + scope.params.length + 3 >= 100) return null;
  // Bound D1 expression depth by evaluating the common guards before the candidate
  // predicates. Passless rows have neither a pass nor any retention proof, so the
  // two candidate branches are disjoint and preserve the original ledger scope.
  return stmt(
    db,
    `WITH authorized_activity AS (
        SELECT (${guard.sql}) AS authorized
      ), scoped_activity AS MATERIALIZED (
        SELECT s.id FROM scans s
        JOIN scanning_devices a ON a.scanner_id=s.scanner_id
          AND a.org_id=s.org_id AND a.mode=s.mode
        JOIN scanning_sessions selected ON selected.id=a.session_id
          AND selected.org_id=a.org_id AND selected.mode=a.mode
        JOIN scanners d ON d.id=a.scanner_id AND d.org_id=a.org_id AND d.mode=a.mode
        WHERE a.org_id=? AND a.session_id=?/* scan-ephemeral-session-id */ AND a.mode=?
          AND (${scope.sql}) AND s.outcome IS NOT NULL AND ${scanLedgerCommonScopeSql('s')}
      ), ledger_activity AS MATERIALIZED (
        SELECT s.id FROM scoped_activity matching JOIN scans s ON s.id=matching.id
        WHERE ${scanLedgerPassOrRetentionCandidateSql('s')}
        UNION ALL
        SELECT s.id FROM scoped_activity matching JOIN scans s ON s.id=matching.id
        WHERE ${scanPasslessCandidateSql('s')}
      ), activity_rows AS (
        SELECT s.id,s.at,s.scanner_id AS deviceId,d.name AS deviceName,s.pass_id AS passId,
          s.event_id AS eventId,s.template_id AS templateId,
          CASE WHEN s.undone_by IS NOT NULL THEN 'undone' ELSE s.outcome END AS outcome,s.direction,
          p.serial AS serial,p.scan_code AS scanCode,p.barcode_hash AS barcodeHash,p.lookup_hash AS lookupHash,
          CASE WHEN json_valid(wallet.pass_json) THEN
            CASE WHEN typeof(COALESCE(json_extract(wallet.pass_json,'$.barcodes[0].message'),
              json_extract(wallet.pass_json,'$.barcode.message')))='text'
            THEN NULLIF(COALESCE(json_extract(wallet.pass_json,'$.barcodes[0].message'),
              json_extract(wallet.pass_json,'$.barcode.message')),'') END END AS barcodeMessage,
          CASE WHEN json_valid(p.personalization) AND json_valid(pinned.manifest) THEN (
            SELECT CAST(value.value AS TEXT) FROM json_each(p.personalization) value
            WHERE value.key=json_extract(pinned.manifest,'$.scan.lookup.input')
              AND value.type IN ('text','integer','real') LIMIT 1) END AS lookupValue
        FROM ledger_activity matching JOIN scans s ON s.id=matching.id
        JOIN scanners d ON d.id=s.scanner_id AND d.org_id=s.org_id AND d.mode=s.mode
        LEFT JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode
        LEFT JOIN pass_versions wallet ON wallet.pass_id=p.id AND wallet.version=(
          SELECT version FROM pass_versions WHERE pass_id=p.id AND version<=p.version
            ORDER BY version DESC LIMIT 1)
        LEFT JOIN template_versions pinned ON pinned.template_id=p.template_id AND pinned.version=p.template_version
        ORDER BY s.at DESC,s.id DESC LIMIT 20
      ) SELECT authorized_activity.authorized,activity_rows.*
        FROM authorized_activity LEFT JOIN activity_rows
          ON authorized_activity.authorized=1
        ORDER BY activity_rows.at DESC,activity_rows.id DESC`,
    [...guard.params, row.org_id, row.id, row.mode, ...scope.params],
  );
}

/** Compare credential source bytes and current tombstones in the final read batch. */
export function activityCredentialFenceStmt(
  db: D1Database,
  row: ScanningSessionRow,
  candidate: ActivityCandidate,
  refs: readonly string[],
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id FROM scans s JOIN passes p
    ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode
    WHERE s.id=?/* scan-ephemeral-scan-id */ AND s.org_id=? AND s.mode=?
      AND p.id=?/* scan-ephemeral-pass-id */ AND p.serial IS ?/* scan-ephemeral-serial */
      AND p.scan_code IS ?/* scan-ephemeral-scan-code */
      AND p.barcode_hash IS ?/* scan-ephemeral-barcode-hash */
      AND p.lookup_hash IS ?/* scan-ephemeral-lookup-hash */
      AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones retired
        WHERE retired.org_id=s.org_id AND retired.mode=s.mode
          AND retired.credential_hash IN (SELECT value FROM json_each(?/* scan-ephemeral-credential-refs */)))`,
    [
      candidate.id,
      row.org_id,
      row.mode,
      candidate.passId,
      candidate.serial,
      candidate.scanCode,
      candidate.barcodeHash,
      candidate.lookupHash,
      JSON.stringify(refs),
    ],
  );
}
