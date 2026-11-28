import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import { issuedReleasePredicateSql } from '../templates/repo-releases.ts';
import { RACE_CARD_HISTORY } from './race-tags.ts';
import { passLineagePredicate } from './repo-history-lineage.ts';
import {
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import type { Raw } from './repo-scan-map.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';
import type { ScanPredicate } from './scan-predicate.ts';

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

const CARD_HISTORY_SQL = `${RACE_CARD_HISTORY} WITH selected_scans AS MATERIALIZED (
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
       WHERE p.org_id = ? AND p.mode = ?
         AND p.id = ?
         AND p.template_id = ?
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
  return stmt(db, CARD_HISTORY_SQL, [query.orgId, query.mode, query.passId, query.templateId]);
}

export type CardHistoryFence = ScanPredicate;

/**
 * Recheck in the final actor/pass authorization statement that the pass is still the one the rows
 * were read for, and that none of the shown scans was undone since (`undoable` stays honest). The
 * rows came from one snapshot; only a moved credential or lifecycle, a pending transfer, a deleted
 * pass or an undo changes what they may show. A scanner renamed after the read still shows its old
 * name for that one response: the viewer could see it a moment earlier.
 */
export function cardHistoryFence(
  query: CardHistoryQuery,
  rows: readonly CardHistoryRow[],
): CardHistoryFence | null {
  const row = rows[0];
  if (!row) return null;
  if (rows.length > 3) throw new RangeError('At most three card scans may be fenced');
  const lineage = passLineagePredicate({
    orgId: query.orgId,
    mode: query.mode,
    passId: query.passId,
    credentialGeneration: row.current_credential_generation,
    lifecycleGeneration: row.current_lifecycle_generation,
  });
  return {
    sql: `(${lineage.sql}) AND NOT EXISTS (SELECT 1 FROM scans shown
      WHERE shown.id IN (${rows.map(() => '?').join(', ')})
        AND shown.undone_by IS NOT NULL)`,
    params: [...lineage.params, ...rows.map((shown) => shown.id)],
  };
}
