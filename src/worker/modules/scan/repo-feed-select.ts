import {
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { releaseBuildCompatibilitySql } from './repo-release-build.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql } from './repo-scan-retention.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

const recordedProofCandidateSql = (scan: 's' | 'cs') => `EXISTS (
  SELECT 1 FROM pass_events proof_event
  JOIN pass_versions recorded_version ON recorded_version.pass_id = ${scan}.pass_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.walletVersion') = 'integer'
      AND recorded_version.version = json_extract(proof_event.data, '$.authority.walletVersion')
      AND json_type(proof_event.data, '$.authority.walletTemplateVersion') IN ('null', 'text')
      AND recorded_version.template_version IS json_extract(proof_event.data, '$.authority.walletTemplateVersion')
      ELSE 0 END
    AND recorded_version.version > 0 AND recorded_version.version <= ${scan}.pass_version
  JOIN template_versions recorded_template ON recorded_template.template_id = ${scan}.template_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.pinnedTemplateVersion') = 'text'
      AND recorded_template.version = json_extract(proof_event.data, '$.authority.pinnedTemplateVersion')
      ELSE 0 END
  WHERE proof_event.id = (${uniqueScanEventIdSql(scan)})
    AND CASE WHEN json_valid(proof_event.data) THEN
      COALESCE(json_extract(proof_event.data, '$.authority.releaseClass'), json_extract(proof_event.data, '$.authority.eventProof.releaseClass')) IS NOT NULL
      AND (${scanCurrentCredentialLineageSql('p', 'proof_event')})
      AND ((COALESCE(json_extract(proof_event.data, '$.authority.releaseClass'), json_extract(proof_event.data, '$.authority.eventProof.releaseClass')) = 'approved' AND (${recordedScanProvenanceSql(
        {
          scanAlias: scan,
          ledgerAlias: 'proof_event',
          recordedTemplateVersionSql: 'recorded_template.version',
          walletVersionSql: 'recorded_version.version',
          walletTemplateVersionSql: 'recorded_version.template_version',
        },
      )})) OR (
      COALESCE(json_extract(proof_event.data, '$.authority.releaseClass'), json_extract(proof_event.data, '$.authority.eventProof.releaseClass')) = 'legacy'
      AND (${legacyScanProvenanceSql({
        scanAlias: scan,
        ledgerAlias: 'proof_event',
        recordedTemplateVersionSql: 'recorded_template.version',
        walletVersionSql: 'recorded_version.version',
        walletTemplateVersionSql: 'recorded_version.template_version',
      })})
    )) ELSE 0 END
)`;

// Candidate policy is shared by projections, pass-id filters and cursors. Every event MAC is
// verified separately before its candidate row can expose pass identity.
export const policyCandidateSql = (scan: 's' | 'cs', nowSql = '?') => `(CASE
  WHEN ${scanPasslessCandidateSql(scan)} THEN 1
  WHEN EXISTS (
    SELECT 1 FROM passes p
    JOIN templates t ON t.id = p.template_id AND (t.org_id IS NULL OR t.org_id = p.org_id)
      AND t.status != 'deleted'
    JOIN template_versions pinned_version
      ON pinned_version.template_id = p.template_id AND pinned_version.version = p.template_version
    LEFT JOIN template_releases policy_release ON policy_release.id = (${usedReleaseIdSql('p')})
    WHERE p.id = ${scan}.pass_id AND p.org_id = ${scan}.org_id AND p.mode = ${scan}.mode
      AND p.template_id = ${scan}.template_id
      AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.status = 'active'
      AND p.test_data_quarantined = 0
      AND CASE WHEN json_valid(p.personalization) AND json_valid(p.field_sources)
        THEN json_type(p.personalization) = 'object' AND json_type(p.field_sources) = 'object'
        ELSE 0 END
      AND (p.connection_id IS NULL OR EXISTS (
        SELECT 1 FROM connections c WHERE c.id = p.connection_id AND c.org_id = p.org_id
          AND c.enabled = 1 AND c.generation IS NOT NULL
      ))
      AND ${walletSnapshotPredicateSql({ nowSql })}
      AND CASE WHEN policy_release.id IS NOT NULL
        THEN ${releaseBuildCompatibilitySql('policy_release.version')}
        WHEN p.release_id IS NULL THEN 1
        ELSE 0 END
      AND ${recordedProofCandidateSql(scan)}
  ) THEN 1 ELSE 0 END)`;

/** Primary-key joins keep the page cardinality unchanged; scope checks use bounded probes. */
export const SELECT = `SELECT s.id, s.org_id, s.mode, s.at, s.outcome, s.reason, s.action_id, s.action_kind, s.direction,
    s.pass_id, s.template_id, t.name AS template_name,
    ${policyCandidateSql('s')} AS policy_candidate,
    CASE WHEN ${scanRetentionCandidateSql('s')} THEN 1 ELSE 0 END AS retention_candidate,
    CASE WHEN ${scanPasslessCandidateSql('s')} THEN 1 ELSE 0 END AS passless_proof_candidate,
    CASE WHEN current_pass.id IS NOT NULL THEN json_object(
      'passId', current_pass.id, 'orgId', current_pass.org_id, 'mode', current_pass.mode,
      'templateId', current_pass.template_id, 'templateVersion', current_pass.template_version,
      'issuanceReleaseId', current_pass.release_id, 'passVersion', current_pass.version,
      'passRevision', current_pass.revision, 'linkGeneration', current_pass.link_generation,
      'credentialGeneration', current_pass.credential_generation,
      'lifecycleGeneration', current_pass.lifecycle_generation,
      'identityId', current_pass.identity_id, 'identityRevision', current_identity.revision,
      'connectionId', current_pass.connection_id, 'connectionGeneration', current_connection.generation,
      'orgRevision', current_org.access_revision,
      'headId', current_head.id, 'headGeneration', current_head.generation,
      'headVersion', current_head.version, 'headCandidateHash', current_head.candidate_hash,
      'walletVersion', current_wallet.version, 'walletTemplateVersion', current_wallet.template_version
    ) END AS key_snapshot,
    CASE WHEN json_valid(proof_event.data) THEN
      CASE WHEN COALESCE(json_extract(proof_event.data, '$.authority.releaseClass'), json_extract(proof_event.data, '$.authority.eventProof.releaseClass')) IS NOT NULL
      THEN json_object('id', proof_event.id, 'org_id', proof_event.org_id, 'pass_id', proof_event.pass_id,
        'mode', proof_event.mode, 'kind', proof_event.kind, 'device', proof_event.device,
        'actor_type', proof_event.actor_type, 'actor_id', proof_event.actor_id,
        'data', proof_event.data, 'at', proof_event.at)
      END END AS proof_event,
    recorded_template.version AS recorded_template_version,
    recorded_version.version AS recorded_wallet_version,
    recorded_version.template_version AS recorded_wallet_template_version,
    wallet_template.version AS event_wallet_version,
    wallet_template.manifest AS event_wallet_manifest,
    current_pass.personalization AS current_personalization,
    recorded_version.personalization AS version_personalization,
    recorded_template.manifest AS event_pinned_manifest,
    event_active_template.version AS event_active_version,
    event_active_template.manifest AS event_active_manifest,
    event_legacy_template.version AS event_legacy_version,
    event_legacy_template.manifest AS event_legacy_manifest,
    s.actor_key AS proof_actor_key, s.state AS proof_state, s.scanner_id AS proof_scanner_id,
    s.event_id AS proof_event_id, s.staff_id AS proof_staff_id, s.approved_by AS proof_approved_by,
    s.override_of AS proof_override_of, s.undoes AS proof_undoes, s.undone_by AS proof_undone_by,
    s.presence_scope AS proof_presence_scope,
    e.id AS event_id, e.name AS event_name,
    sc.id AS scanner_id, sc.name AS scanner_name, st.id AS staff_id, st.name AS staff_name,
    ap.name AS approver_name, s.method, s.amount, s.before_value, s.after_value, s.pass_version, s.override_of,
    s.offline, s.actor_type, s.actor_id, s.undone_at, u.id AS undone_by,
    undo_target.id AS undoes,
    coalesce(ust.name, usc.name, CASE WHEN u.actor_type = 'user' THEN 'Admin console' END) AS undone_by_name
  FROM scans s
  LEFT JOIN pass_events proof_event ON proof_event.id = (${uniqueScanEventIdSql('s')})
  LEFT JOIN pass_versions recorded_version ON recorded_version.pass_id = s.pass_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.walletVersion') = 'integer'
      AND recorded_version.version = json_extract(proof_event.data, '$.authority.walletVersion')
      AND json_type(proof_event.data, '$.authority.walletTemplateVersion') IN ('null', 'text')
      AND recorded_version.template_version IS json_extract(proof_event.data, '$.authority.walletTemplateVersion')
      ELSE 0 END
    AND recorded_version.version > 0 AND recorded_version.version <= s.pass_version
  LEFT JOIN passes current_pass ON current_pass.id = s.pass_id
    AND current_pass.org_id = s.org_id AND current_pass.mode = s.mode
    AND current_pass.template_id = s.template_id
  LEFT JOIN signing_identities current_identity ON current_identity.id = current_pass.identity_id
    AND (current_identity.org_id IS NULL OR current_identity.org_id = current_pass.org_id)
  LEFT JOIN pass_versions current_wallet ON current_wallet.pass_id = current_pass.id
    AND current_wallet.version = (SELECT v.version FROM pass_versions v
      WHERE v.pass_id = current_pass.id AND v.version <= current_pass.version
      ORDER BY v.version DESC LIMIT 1)
  LEFT JOIN template_releases current_head ON current_head.id = (${usedReleaseIdSql('current_pass')})
  LEFT JOIN orgs current_org ON current_org.id = current_pass.org_id
  LEFT JOIN connections current_connection ON current_connection.id = current_pass.connection_id
    AND current_connection.org_id = current_pass.org_id AND current_connection.enabled = 1
  LEFT JOIN template_versions recorded_template ON recorded_template.template_id = s.template_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.pinnedTemplateVersion') = 'text'
      AND recorded_template.version = json_extract(proof_event.data, '$.authority.pinnedTemplateVersion')
      ELSE 0 END
  LEFT JOIN template_versions wallet_template ON wallet_template.template_id = s.template_id
    AND wallet_template.version = recorded_version.template_version
  LEFT JOIN template_versions event_active_template ON event_active_template.template_id = s.template_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.activeReleaseVersion') = 'text'
      AND event_active_template.version = json_extract(proof_event.data, '$.authority.activeReleaseVersion')
      ELSE 0 END
  LEFT JOIN template_versions event_legacy_template ON event_legacy_template.template_id = s.template_id
    AND CASE WHEN json_valid(proof_event.data) THEN
      json_type(proof_event.data, '$.authority.activeTemplateVersion') = 'text'
      AND event_legacy_template.version = json_extract(proof_event.data, '$.authority.activeTemplateVersion')
      ELSE 0 END
  LEFT JOIN templates t ON t.id = s.template_id AND (t.org_id IS NULL OR t.org_id = s.org_id)
  LEFT JOIN scan_events e ON e.id = s.event_id AND e.org_id = s.org_id AND e.mode = s.mode
    AND (s.pass_id IS NOT NULL OR e.archived_at IS NULL)
  LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = s.org_id AND sc.mode = s.mode
  LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = s.org_id
  LEFT JOIN scan_staff ap ON ap.id = s.approved_by AND ap.org_id = s.org_id
  LEFT JOIN scans u ON u.id = s.undone_by AND u.org_id = s.org_id AND u.mode = s.mode
  LEFT JOIN scans undo_target
    ON undo_target.id = s.undoes AND undo_target.org_id = s.org_id AND undo_target.mode = s.mode
  LEFT JOIN scan_staff ust ON ust.id = u.staff_id AND ust.org_id = s.org_id
  LEFT JOIN scanners usc ON usc.id = u.scanner_id AND usc.org_id = s.org_id AND usc.mode = s.mode`;
