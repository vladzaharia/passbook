import {
  currentWalletPrivateValuesSql,
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
} from './repo-history-provenance.ts';
import { releaseBuildCompatibilitySql } from './repo-release-build.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql } from './repo-scan-retention.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

/*
 * One flag per concept, each computed once over the joined aliases of `repo-history-rows.ts`:
 * s scan, l its ledger event, recorded the Wallet version it recorded, rtv the template version
 * it pinned, p the pass, t its template, cpv the pass's own template version, ar the release it
 * is used under, cw its current Wallet row, conn its connection, o its org. The AND happens in
 * JS (`history-row.ts`). `history-row-shadow.test.ts` pins each combination to the old
 * `policyCandidateSql` and `projection_current`.
 */

const flag = (sql: string) => `CASE WHEN ${sql} THEN 1 ELSE 0 END`;

const provenance = {
  scanAlias: 's',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: 'rtv.version',
  walletVersionSql: 'recorded.version',
  walletTemplateVersionSql: 'recorded.template_version',
};

const authorityText = (name: string) =>
  `CASE WHEN json_valid(l.data) AND json_type(l.data,'$.authority.${name}')='text'
    THEN json_extract(l.data,'$.authority.${name}') END`;

/** Typed event-time keys: only a text value names a version. */
export const EVENT_PINNED_KEY = authorityText('pinnedTemplateVersion');
export const EVENT_ACTIVE_KEY = authorityText('activeTemplateVersion');

export const HISTORY_FLAG_COLUMNS = `${flag(scanPasslessCandidateSql('s'))} AS passless_candidate,
    ${flag(scanRetentionCandidateSql('s'))} AS retention_candidate,
    ${flag('l.id IS NOT NULL')} AS has_ledger,
    ${flag('recorded.version IS NOT NULL')} AS has_recorded,
    ${flag('rtv.version IS NOT NULL')} AS has_recorded_template,
    CASE WHEN json_valid(l.data) THEN COALESCE(json_extract(l.data,'$.authority.releaseClass'),
      json_extract(l.data,'$.authority.eventProof.releaseClass')) END AS release_class,
    ${flag(`l.id IS NOT NULL AND (${scanCurrentCredentialLineageSql('p', 'l')})`)} AS lineage_ok,
    ${flag(`l.id IS NOT NULL AND (${recordedScanProvenanceSql(provenance)})`)} AS approved_proof,
    ${flag(`l.id IS NOT NULL AND (${legacyScanProvenanceSql(provenance)})`)} AS legacy_proof,
    ${flag(`p.id IS NOT NULL AND t.id IS NOT NULL AND t.status != 'deleted'
      AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.status = 'active'
      AND p.test_data_quarantined = 0`)} AS pass_ok,
    ${flag(`cpv.version IS NOT NULL
      AND CASE WHEN json_valid(p.personalization) AND json_valid(p.field_sources)
        THEN json_type(p.personalization) = 'object' AND json_type(p.field_sources) = 'object'
        ELSE 0 END
      AND (p.connection_id IS NULL OR (conn.id IS NOT NULL AND conn.generation IS NOT NULL))
      AND CASE WHEN ar.id IS NOT NULL THEN ${releaseBuildCompatibilitySql('ar.version')}
        WHEN p.release_id IS NULL THEN 1 ELSE 0 END`)} AS policy_extra_ok,
    ${flag(`o.status = 'active' AND (p.connection_id IS NULL OR conn.id IS NOT NULL)
      AND (ar.id IS NOT NULL OR (cpv.version IS NOT NULL AND p.release_id IS NULL))`)} AS projection_extra_ok,
    ${flag(walletSnapshotPredicateSql({ nowSql: '?' }))} AS wallet_ok,
    ${flag(`EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id = p.id AND transfer.state = 'pending')`)} AS transfer_pending`;

/** The columns policy evaluation reads, with the pass's credentials only where a pass is current. */
export const HISTORY_SOURCE_COLUMNS = `recorded.version AS recorded_wallet_version,
    recorded.template_version AS recorded_wallet_template_version,
    recorded.personalization AS recorded_personalization,
    ${EVENT_PINNED_KEY} AS event_pinned_version,
    ${EVENT_ACTIVE_KEY} AS event_active_version,
    cpv.version AS current_pinned_version,
    COALESCE(ar.version, CASE WHEN p.release_id IS NULL THEN cpv.version END) AS current_active_version,
    p.personalization AS current_personalization,
    p.credential_generation AS current_credential_generation,
    p.lifecycle_generation AS current_lifecycle_generation,
    p.serial AS pass_serial, p.auth_token AS pass_auth_token,
    p.download_token AS pass_download_token, p.web_service_url AS pass_web_service_url,
    p.scan_code AS pass_scan_code, p.external_id AS pass_external_id,
    p.holder_email AS pass_holder_email,
    CASE WHEN l.id IS NOT NULL AND p.id IS NOT NULL
      THEN ${currentWalletPrivateValuesSql('cw')} END AS current_wallet_private_values,
    l.id AS ledger_id, l.org_id AS ledger_org_id, l.pass_id AS ledger_pass_id,
    l.mode AS ledger_mode, l.kind AS ledger_kind, l.device AS ledger_device,
    l.actor_type AS ledger_actor_type, l.actor_id AS ledger_actor_id,
    l.data AS ledger_data, l.at AS ledger_at`;
