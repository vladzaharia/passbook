import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import {
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import type { Raw } from './repo-scan-map.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';

export interface CardHistoryQuery {
  orgId: string;
  mode: Mode;
  passId: string;
  templateId: string;
}

/** Unverified historical evidence; callers must verify the event MAC before projecting it. */
export interface CardHistoryRow extends Raw {
  actor_type: string;
  scanner_name: string | null;
  approved_proof: number;
  legacy_proof: number;
  event_json: string | null;
  recorded_wallet_version: number | null;
  recorded_wallet_template_version: string | null;
  recorded_template_version: string | null;
  current_credential_generation: number;
  current_lifecycle_generation: number;
  current_pending_transfer: number;
  current_personalization: string;
  recorded_personalization: string | null;
  recorded_wallet_manifest: string | null;
  recorded_manifest: string | null;
  event_active_manifest: string | null;
  event_legacy_manifest: string | null;
}

export const CARD_HISTORY_CANDIDATE_LIMIT = 64;

const cardHistorySql = (selectedCount: number) => `WITH selected_scans AS MATERIALIZED (
       SELECT s.*, p.personalization AS current_personalization,
         p.credential_generation AS current_credential_generation,
         p.lifecycle_generation AS current_lifecycle_generation,
         EXISTS (SELECT 1 FROM pass_credential_transfers transfer
           WHERE transfer.pass_id = p.id AND transfer.state = 'pending') AS current_pending_transfer
       FROM scans s
       JOIN passes p ON p.id = s.pass_id AND p.org_id = s.org_id AND p.mode = s.mode
         AND p.template_id = s.template_id
       JOIN templates t ON t.id = p.template_id AND (t.org_id IS NULL OR t.org_id = p.org_id)
         AND t.status != 'deleted'
       WHERE p.org_id = ?/* scan-ephemeral-card-history */ AND p.mode = ?
         AND p.id = ?/* scan-ephemeral-card-history */
         AND p.template_id = ?/* scan-ephemeral-card-history */
         AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.status = 'active'
         AND p.test_data_quarantined = 0
         AND (p.release_id IS NULL OR ${issuedReleasePredicateSql(
           {
             releaseIdSql: 'p.release_id',
             versionSql: 'p.template_version',
           },
           {
             templateIdSql: 'p.template_id',
             orgIdSql: 'p.org_id',
             modeSql: 'p.mode',
             providerSql: "'apple'",
           },
         )})
         ${
           selectedCount === 0
             ? ''
             : `AND s.id IN (${Array.from(
                 { length: selectedCount },
                 () => '?/* scan-ephemeral-card-history */',
               ).join(', ')})`
         }
         AND s.state = 'done' AND s.action_kind IS NOT 'undo'
         AND NOT ${scanRetentionExcludedSql('s')}
         AND (s.actor_type != 'scanner' OR NOT EXISTS (
           SELECT 1 FROM scanners x WHERE x.id = s.actor_id
             AND (x.org_id != s.org_id OR x.mode != s.mode)
         ))
         AND NOT EXISTS (SELECT 1 FROM scan_events x WHERE x.id = s.event_id
           AND (x.org_id != s.org_id OR x.mode != s.mode))
         AND NOT EXISTS (SELECT 1 FROM scanners x WHERE x.id = s.scanner_id
           AND (x.org_id != s.org_id OR x.mode != s.mode))
         AND NOT EXISTS (SELECT 1 FROM scan_staff x WHERE (x.id = s.staff_id OR x.id = s.approved_by)
           AND x.org_id != s.org_id)
         AND NOT EXISTS (SELECT 1 FROM scans x
           WHERE (x.id = s.undoes OR x.id = s.undone_by OR x.id = s.override_of)
             AND (x.org_id != s.org_id OR x.mode != s.mode OR x.pass_id IS NOT s.pass_id))
       ORDER BY s.at DESC, s.id DESC LIMIT ${CARD_HISTORY_CANDIDATE_LIMIT}
     )
     SELECT s.id, s.org_id, s.mode, s.pass_id, s.template_id, s.scanner_id, s.event_id,
       s.actor_type, s.actor_key, s.staff_id, s.request_hash, s.state, s.outcome, s.reason, s.action_id,
       s.action_kind, s.override_of, s.approved_by, s.pass_version, s.method, s.at,
       s.undone_by, s.direction, s.presence_scope, scanner.name AS scanner_name,
       CASE WHEN proof_event.id IS NOT NULL AND recorded_version.version IS NOT NULL
         AND recorded_template.version IS NOT NULL AND json_valid(proof_event.data)
         THEN CASE WHEN (${recordedScanProvenanceSql({
           scanAlias: 's',
           ledgerAlias: 'proof_event',
           recordedTemplateVersionSql: 'recorded_template.version',
           walletVersionSql: 'recorded_version.version',
           walletTemplateVersionSql: 'recorded_version.template_version',
         })}) THEN 1 ELSE 0 END
         ELSE 0 END AS approved_proof,
       CASE WHEN proof_event.id IS NOT NULL AND recorded_version.version IS NOT NULL
         AND recorded_template.version IS NOT NULL AND json_valid(proof_event.data)
         THEN CASE WHEN (${legacyScanProvenanceSql({
           scanAlias: 's',
           ledgerAlias: 'proof_event',
           recordedTemplateVersionSql: 'recorded_template.version',
           walletVersionSql: 'recorded_version.version',
           walletTemplateVersionSql: 'recorded_version.template_version',
         })}) THEN 1 ELSE 0 END
         ELSE 0 END AS legacy_proof,
       CASE WHEN proof_event.id IS NOT NULL AND json_valid(proof_event.data) THEN json_object(
         'id', proof_event.id, 'org_id', proof_event.org_id, 'pass_id', proof_event.pass_id,
         'mode', proof_event.mode, 'kind', proof_event.kind, 'device', proof_event.device,
         'actor_type', proof_event.actor_type, 'actor_id', proof_event.actor_id,
         'data', proof_event.data, 'at', proof_event.at
       ) END AS event_json,
       recorded_version.version AS recorded_wallet_version,
       recorded_version.template_version AS recorded_wallet_template_version,
       recorded_template.version AS recorded_template_version,
       s.current_credential_generation, s.current_lifecycle_generation, s.current_pending_transfer,
       s.current_personalization, recorded_version.personalization AS recorded_personalization,
       recorded_template.manifest AS recorded_manifest, wallet_template.manifest AS recorded_wallet_manifest,
       event_active_template.manifest AS event_active_manifest,
       event_legacy_template.manifest AS event_legacy_manifest
     FROM selected_scans s
     JOIN passes lineage_pass ON lineage_pass.id = s.pass_id
       AND lineage_pass.org_id = s.org_id AND lineage_pass.mode = s.mode
       AND lineage_pass.credential_generation = s.current_credential_generation
     LEFT JOIN scanners scanner ON scanner.id = s.scanner_id
       AND scanner.org_id = s.org_id AND scanner.mode = s.mode
     LEFT JOIN pass_events proof_event ON proof_event.id = (${uniqueScanEventIdSql('s')})
       AND s.current_credential_generation >= 1 AND s.current_pending_transfer = 0
       AND (${scanCurrentCredentialLineageSql('lineage_pass', 'proof_event')})
     LEFT JOIN pass_versions recorded_version ON recorded_version.pass_id = s.pass_id
       AND recorded_version.version = CASE WHEN json_valid(proof_event.data) THEN
         CASE WHEN json_type(proof_event.data, '$.authority.walletVersion') = 'integer'
           THEN json_extract(proof_event.data, '$.authority.walletVersion') END
       END
       AND recorded_version.version > 0 AND recorded_version.version <= s.pass_version
       AND CASE WHEN json_valid(proof_event.data) THEN
         CASE WHEN json_type(proof_event.data, '$.authority.walletTemplateVersion') IN ('null', 'text')
           THEN recorded_version.template_version IS json_extract(proof_event.data, '$.authority.walletTemplateVersion')
           ELSE 0 END
       ELSE 0 END
     LEFT JOIN template_versions recorded_template ON recorded_template.template_id = s.template_id
       AND recorded_template.version = CASE WHEN json_valid(proof_event.data) THEN
         CASE WHEN json_type(proof_event.data, '$.authority.pinnedTemplateVersion') = 'text'
           THEN json_extract(proof_event.data, '$.authority.pinnedTemplateVersion') END
       END
     LEFT JOIN template_versions wallet_template ON wallet_template.template_id = s.template_id
       AND wallet_template.version = recorded_version.template_version
     LEFT JOIN template_versions event_active_template ON event_active_template.template_id = s.template_id
       AND event_active_template.version = CASE WHEN json_valid(proof_event.data) THEN
         CASE WHEN json_type(proof_event.data, '$.authority.activeReleaseVersion') = 'text'
           THEN json_extract(proof_event.data, '$.authority.activeReleaseVersion') END
       END
     LEFT JOIN template_versions event_legacy_template ON event_legacy_template.template_id = s.template_id
       AND event_legacy_template.version = CASE WHEN json_valid(proof_event.data) THEN
         CASE WHEN json_type(proof_event.data, '$.authority.activeTemplateVersion') = 'text'
           THEN json_extract(proof_event.data, '$.authority.activeTemplateVersion') END
       END
     ORDER BY s.at DESC, s.id DESC`;

/**
 * Scope the newest candidates before the fixed budget, then attach at most one event and each
 * immutable policy snapshot. Missing or ambiguous ledger evidence never grants authority.
 */
export function cardHistoryStmt(db: D1Database, query: CardHistoryQuery): D1PreparedStatement {
  return stmt(db, cardHistorySql(0), [query.orgId, query.mode, query.passId, query.templateId]);
}

export interface CardHistoryFence {
  sql: string;
  params: readonly SqlValue[];
}

const HISTORY_COLUMNS = [
  'id',
  'org_id',
  'mode',
  'pass_id',
  'template_id',
  'scanner_id',
  'event_id',
  'actor_key',
  'staff_id',
  'request_hash',
  'state',
  'outcome',
  'reason',
  'action_id',
  'action_kind',
  'override_of',
  'approved_by',
  'pass_version',
  'method',
  'at',
  'undone_by',
  'direction',
  'presence_scope',
  'scanner_name',
  'approved_proof',
  'legacy_proof',
  'event_json',
  'recorded_wallet_version',
  'recorded_wallet_template_version',
  'recorded_template_version',
  'current_credential_generation',
  'current_lifecycle_generation',
  'current_pending_transfer',
  'current_personalization',
  'recorded_personalization',
  'recorded_wallet_manifest',
  'recorded_manifest',
  'event_active_manifest',
  'event_legacy_manifest',
] as const satisfies readonly (keyof CardHistoryRow)[];

/** Classify by source column; shared deduplicated values inherit the strongest classification. */
const SENSITIVE_HISTORY_COLUMNS: Partial<Record<keyof CardHistoryRow, true>> = {
  id: true,
  org_id: true,
  pass_id: true,
  template_id: true,
  scanner_id: true,
  event_id: true,
  actor_key: true,
  staff_id: true,
  request_hash: true,
  reason: true,
  action_id: true,
  override_of: true,
  approved_by: true,
  pass_version: true,
  at: true,
  undone_by: true,
  presence_scope: true,
  scanner_name: true,
  event_json: true,
  recorded_wallet_version: true,
  recorded_wallet_template_version: true,
  recorded_template_version: true,
  current_credential_generation: true,
  current_lifecycle_generation: true,
  current_pending_transfer: true,
  current_personalization: true,
  recorded_personalization: true,
  recorded_wallet_manifest: true,
  recorded_manifest: true,
  event_active_manifest: true,
  event_legacy_manifest: true,
};

/** Recheck the original bounded rows in the final actor/pass authorization statement. */
export function cardHistoryFence(
  query: CardHistoryQuery,
  rows: readonly CardHistoryRow[],
): CardHistoryFence | null {
  if (rows.length === 0) return null;
  if (rows.length > 3) throw new RangeError('At most three card scans may be fenced');
  const values: SqlValue[] = [];
  const slots = new Map<SqlValue, number>();
  const sensitiveSlots = new Set<number>();
  const reference = (column: keyof CardHistoryRow, value: SqlValue): string => {
    let slot = slots.get(value);
    if (slot === undefined) {
      slot = values.length;
      slots.set(value, slot);
      values.push(value);
    }
    if (SENSITIVE_HISTORY_COLUMNS[column]) sensitiveSlots.add(slot);
    return `snapshot.v${slot}`;
  };
  const matches = rows
    .map(
      (row) =>
        `(${HISTORY_COLUMNS.map((column) => `history.${column} IS ${reference(column, row[column])}`).join(' AND ')})`,
    )
    .join(' OR ');
  const snapshot = values
    .map(
      (_, index) =>
        `${sensitiveSlots.has(index) ? '?/* scan-ephemeral-card-history */' : '?'} AS v${index}`,
    )
    .join(', ');
  return {
    sql: `(WITH snapshot AS MATERIALIZED (SELECT ${snapshot})
      SELECT CASE WHEN count(*) = ?
        AND SUM(CASE WHEN ${matches} THEN 1 ELSE 0 END) = ? THEN 1 ELSE 0 END
      FROM (${cardHistorySql(rows.length)}) history CROSS JOIN snapshot)`,
    params: [
      ...values,
      rows.length,
      rows.length,
      query.orgId,
      query.mode,
      query.passId,
      query.templateId,
      ...rows.map((row) => row.id),
    ],
  };
}
