import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import {
  currentWalletPrivateValuesSql,
  legacyScanProvenanceSql,
  recordedScanProvenanceSql,
  scanCurrentCredentialLineageSql,
  uniqueScanEventIdSql,
} from './repo-history-provenance.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { HISTORICAL_SCOPE_SQL } from './repo-scan-history.ts';
import type { Raw } from './repo-scan-map.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

const EVENT_WALLET =
  "CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.walletVersion') END";
const EVENT_PINNED =
  "CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.pinnedTemplateVersion') END";
const EVENT_ACTIVE =
  "CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.activeTemplateVersion') END";
const RECORDED_PROOF_SQL = recordedScanProvenanceSql({
  scanAlias: 's',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: `(${EVENT_PINNED})`,
  walletVersionSql: 'recorded.version',
  walletTemplateVersionSql: 'recorded.template_version',
});
const LEGACY_PROOF_SQL = legacyScanProvenanceSql({
  scanAlias: 's',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: `(${EVENT_PINNED})`,
  walletVersionSql: 'recorded.version',
  walletTemplateVersionSql: 'recorded.template_version',
});
const UNIQUE_EVENT_SQL = uniqueScanEventIdSql('s');

type HistoryTextColumn =
  | 'before_value'
  | 'after_value'
  | 'recorded_wallet_template_version'
  | 'event_wallet_manifest'
  | 'recorded_template_version'
  | 'recorded_personalization'
  | 'event_pinned_manifest'
  | 'event_active_version'
  | 'event_active_manifest'
  | 'current_personalization'
  | 'current_title'
  | 'current_scanner_name'
  | 'pass_serial'
  | 'pass_auth_token'
  | 'pass_download_token'
  | 'pass_web_service_url'
  | 'pass_scan_code'
  | 'pass_external_id'
  | 'pass_holder_email'
  | 'current_wallet_private_values'
  | 'current_pinned_version'
  | 'current_pinned_manifest'
  | 'current_active_version'
  | 'current_active_manifest'
  | 'current_identity_id'
  | 'current_connection_id'
  | 'current_release_id'
  | 'current_release_hash'
  | 'ledger_id'
  | 'ledger_org_id'
  | 'ledger_pass_id'
  | 'ledger_device'
  | 'ledger_actor_type'
  | 'ledger_actor_id'
  | 'ledger_data';
type HistoryNumberColumn =
  | 'amount'
  | 'recorded_wallet_version'
  | 'current_pass_version'
  | 'current_pass_revision'
  | 'current_credential_generation'
  | 'current_lifecycle_generation'
  | 'current_image_generation'
  | 'current_link_generation'
  | 'current_connection_generation'
  | 'current_org_revision'
  | 'current_template_revision'
  | 'current_wallet_version'
  | 'current_identity_revision'
  | 'current_release_generation'
  | 'ledger_at';
export type HistoryProofRow = Raw &
  Record<HistoryTextColumn, string | null> &
  Record<HistoryNumberColumn, number | null> & {
    current_transfer_pending: number;
    projection_current: number;
    approved_proof: number;
    legacy_proof: number;
    ledger_mode: EventRow['mode'] | null;
    ledger_kind: EventRow['kind'] | null;
  };

/** Prepare a bounded ID batch or pass-scoped page, for composition with other D1 reads. */
export function historyProofRowsStmt(
  ctx: ServiceContext,
  selection:
    | { ids: readonly string[] }
    | { offset: number; includeTotal: boolean }
    | { pending: { scanId: string; passId: string; walletVersion: number } },
  scopeSql: string,
  scopeParams: readonly SqlValue[],
  credentialKeysetCommitment: string,
): D1PreparedStatement {
  const ids = 'ids' in selection ? selection.ids : null;
  const page = 'offset' in selection ? selection : null;
  const pending = 'pending' in selection ? selection.pending : null;
  if (ids && (!ids.length || ids.length + scopeParams.length + 2 > 100))
    return stmt(ctx.env.DB, 'SELECT 1 WHERE 0');
  const cte = ids
    ? `WITH ids(id) AS (VALUES ${ids.map(() => '(?/* scan-ephemeral-scan-id */)').join(',')})`
    : pending
      ? '/* scan-history-proof-pending */'
      : '/* scan-history-proof-page */';
  const total = page?.includeTotal ? ',COUNT(*) OVER() AS candidate_total' : '';
  return stmt(
    ctx.env.DB,
    `${cte}
    SELECT s.id,s.org_id,s.mode,s.pass_id,s.template_id,s.scanner_id,s.event_id,s.actor_key,s.staff_id${total},
      s.request_hash,s.state,s.outcome,s.reason,s.action_id,s.action_kind,s.override_of,s.approved_by,
      s.pass_version,s.method,s.at,s.undone_by,s.direction,s.presence_scope,s.amount,s.before_value,s.after_value,
      recorded.version AS recorded_wallet_version,recorded.template_version AS recorded_wallet_template_version,
      recorded.personalization AS recorded_personalization,
      (${pending ? 'p.template_version' : EVENT_PINNED}) AS recorded_template_version,event_pinned.manifest AS event_pinned_manifest,
      event_wallet.manifest AS event_wallet_manifest,event_active.version AS event_active_version,
      event_active.manifest AS event_active_manifest,
      p.personalization AS current_personalization,p.display_title AS current_title,
      scanner.name AS current_scanner_name,
      p.serial AS pass_serial,p.auth_token AS pass_auth_token,p.download_token AS pass_download_token,
      p.web_service_url AS pass_web_service_url,p.scan_code AS pass_scan_code,
      p.external_id AS pass_external_id,p.holder_email AS pass_holder_email,
      ${currentWalletPrivateValuesSql('current_wallet')} AS current_wallet_private_values,
      current_pinned.version AS current_pinned_version,current_pinned.manifest AS current_pinned_manifest,
      current_active.version AS current_active_version,current_active.manifest AS current_active_manifest,
      p.version AS current_pass_version,p.revision AS current_pass_revision,
      p.credential_generation AS current_credential_generation,
      p.lifecycle_generation AS current_lifecycle_generation,p.image_generation AS current_image_generation,
      EXISTS(SELECT 1 FROM pass_credential_transfers transfer
        WHERE transfer.pass_id=p.id AND transfer.state='pending') AS current_transfer_pending,
      p.identity_id AS current_identity_id,p.link_generation AS current_link_generation,
      p.connection_id AS current_connection_id,connection.generation AS current_connection_generation,
      org.access_revision AS current_org_revision,org.config_revision AS current_template_revision,
      current_wallet.version AS current_wallet_version,si.revision AS current_identity_revision,
      ar.id AS current_release_id,ar.generation AS current_release_generation,ar.candidate_hash AS current_release_hash,
      CASE WHEN p.status='active' AND p.deleted_at IS NULL AND p.removed_at IS NULL
        AND p.test_data_quarantined=0 AND org.status='active' AND template.status!='deleted'
        AND (p.connection_id IS NULL OR connection.id IS NOT NULL)
        AND (${pending ? "NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer WHERE transfer.pass_id=p.id AND transfer.state='pending')" : scanCurrentCredentialLineageSql('p', 'l')})
        AND (ar.id IS NOT NULL OR legacy.version IS NOT NULL)
        AND ${walletSnapshotPredicateSql({ nowSql: '?' })} THEN 1 ELSE 0 END AS projection_current,
      CASE WHEN l.id IS NOT NULL AND (${RECORDED_PROOF_SQL}) THEN 1 ELSE 0 END AS approved_proof,
      CASE WHEN l.id IS NOT NULL AND (${LEGACY_PROOF_SQL}) THEN 1 ELSE 0 END AS legacy_proof,
      l.id AS ledger_id,l.org_id AS ledger_org_id,l.pass_id AS ledger_pass_id,l.mode AS ledger_mode,
      l.kind AS ledger_kind,l.device AS ledger_device,l.actor_type AS ledger_actor_type,
      l.actor_id AS ledger_actor_id,l.data AS ledger_data,l.at AS ledger_at
    FROM scans s LEFT JOIN passes p ON p.id=${pending ? '?/* scan-ephemeral-pass-id */' : 's.pass_id'}
    LEFT JOIN pass_events l ON l.id=${UNIQUE_EVENT_SQL}
    LEFT JOIN pass_versions recorded ON recorded.pass_id=${pending ? 'p.id' : 's.pass_id'}
      AND recorded.version=(${pending ? '?' : EVENT_WALLET})
      AND recorded.version>0 AND recorded.version<=${pending ? 'p.version' : 's.pass_version'}
    LEFT JOIN template_versions event_pinned ON event_pinned.template_id=${pending ? 'p.template_id' : 's.template_id'}
      AND event_pinned.version=(${pending ? 'p.template_version' : EVENT_PINNED})
    LEFT JOIN template_versions event_wallet ON event_wallet.template_id=${pending ? 'p.template_id' : 's.template_id'}
      AND event_wallet.version=recorded.template_version
    LEFT JOIN template_releases ar ON ar.id=(${usedReleaseIdSql('p')})
    LEFT JOIN template_versions legacy ON legacy.template_id=p.template_id AND legacy.version=p.template_version
      AND p.release_id IS NULL AND ar.id IS NULL
    LEFT JOIN template_versions event_active ON event_active.template_id=${pending ? 'p.template_id' : 's.template_id'}
      AND event_active.version=(${pending ? 'COALESCE(ar.version,legacy.version)' : EVENT_ACTIVE})
    LEFT JOIN template_versions current_pinned ON current_pinned.template_id=p.template_id
      AND current_pinned.version=p.template_version
    LEFT JOIN template_versions current_active ON current_active.template_id=p.template_id
      AND current_active.version=COALESCE(ar.version,legacy.version)
    LEFT JOIN pass_versions current_wallet ON current_wallet.pass_id=p.id AND current_wallet.version=(
      SELECT v.version FROM pass_versions v WHERE v.pass_id=p.id AND v.version<=p.version ORDER BY v.version DESC LIMIT 1)
    LEFT JOIN signing_identities si ON si.id=p.identity_id AND (si.org_id IS NULL OR si.org_id=p.org_id)
    LEFT JOIN connections connection ON connection.id=p.connection_id AND connection.org_id=p.org_id AND connection.enabled=1
    LEFT JOIN orgs org ON org.id=p.org_id
    LEFT JOIN templates template ON template.id=p.template_id AND (template.org_id IS NULL OR template.org_id=p.org_id)
    LEFT JOIN scanners scanner ON scanner.id=s.scanner_id AND scanner.org_id=s.org_id AND scanner.mode=s.mode
    WHERE ${
      ids
        ? 's.id IN (SELECT id FROM ids) AND'
        : pending
          ? "s.id=?/* scan-ephemeral-scan-id */ AND s.state='pending' AND"
          : ''
    } ${scopeSql}
      ${ids ? `AND s.state='done' AND ${HISTORICAL_SCOPE_SQL}` : ''}
      AND ${credentialRefKeysetSql}${page ? ' ORDER BY s.id LIMIT 100 OFFSET ?' : ''}`,
    [
      ...(ids ?? []),
      ctx.clock.now(),
      ...(pending ? [pending.passId, pending.walletVersion, pending.scanId] : []),
      ...scopeParams,
      credentialKeysetCommitment,
      ...(page ? [page.offset] : []),
    ],
  );
}
