/*
 * The old feed's `policyCandidateSql`, kept verbatim as the reference the column flags of
 * `repo-history-rows.ts` are compared with row by row (`history-row-shadow.test.ts`). Deleted
 * with that test once the history reads of slices A2.2 and A2.3 sit on the same flags.
 */
import {
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { releaseBuildCompatibilitySql } from './repo-release-build.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
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
