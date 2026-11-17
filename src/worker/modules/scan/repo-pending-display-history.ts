import { stmt } from '../../platform/db.ts';
import { currentWalletPrivateValuesSql } from './repo-history-provenance.ts';
import { usedReleaseIdSql } from './repo-pass-release-sql.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

type Text = string | null;
type Num = number | null;

/** The claimed scan and the pass state it will be committed under, read before the commit. */
export interface PendingDisplayRow {
  id: string;
  org_id: string;
  mode: 'live' | 'test';
  actor_key: string;
  state: string;
  scanner_id: Text;
  staff_id: Text;
  event_id: Text;
  method: 'camera' | 'wedge' | 'nfc' | 'manual' | 'auto';
  at: number;
  undone_by: Text;
  amount: Num;
  before_value: Text;
  after_value: Text;
  recorded_wallet_version: Num;
  recorded_wallet_template_version: Text;
  recorded_personalization: Text;
  recorded_template_version: Text;
  event_pinned_manifest: Text;
  event_wallet_manifest: Text;
  event_active_version: Text;
  event_active_manifest: Text;
  current_personalization: Text;
  current_scanner_name: Text;
  pass_serial: Text;
  pass_auth_token: Text;
  pass_download_token: Text;
  pass_web_service_url: Text;
  pass_scan_code: Text;
  pass_external_id: Text;
  pass_holder_email: Text;
  current_wallet_private_values: Text;
  current_pinned_version: Text;
  current_pinned_manifest: Text;
  current_active_version: Text;
  current_active_manifest: Text;
  current_pass_version: Num;
  current_pass_revision: Num;
  current_credential_generation: Num;
  current_lifecycle_generation: Num;
  current_image_generation: Num;
  current_transfer_pending: number;
  current_identity_id: Text;
  current_link_generation: Num;
  current_connection_id: Text;
  current_connection_generation: Num;
  current_org_revision: Num;
  current_wallet_version: Num;
  current_identity_revision: Num;
  current_release_id: Text;
  current_release_generation: Num;
  current_release_hash: Text;
  projection_current: number;
}

const TRANSFER_PENDING = `EXISTS (SELECT 1 FROM pass_credential_transfers transfer
  WHERE transfer.pass_id = p.id AND transfer.state = 'pending')`;

/**
 * The pending claim with the pass state and manifests its display is evaluated from, in one
 * statement of the caller's batch. The scan has no pass or ledger event yet: the pass and the
 * recorded Wallet version are the ones the request evaluated.
 */
export function pendingDisplayHistoryStmt(
  db: D1Database,
  input: {
    scanId: string;
    actorKey: string;
    orgId: string;
    mode: string;
    passId: string;
    templateId: string;
    walletVersion: number;
    now: number;
  },
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id, s.org_id, s.mode, s.actor_key, s.state, s.scanner_id, s.staff_id, s.event_id,
      s.method, s.at, s.undone_by, s.amount, s.before_value, s.after_value,
      recorded.version AS recorded_wallet_version,
      recorded.template_version AS recorded_wallet_template_version,
      recorded.personalization AS recorded_personalization,
      p.template_version AS recorded_template_version,
      current_pinned.manifest AS event_pinned_manifest,
      event_wallet.manifest AS event_wallet_manifest,
      current_active.version AS event_active_version, current_active.manifest AS event_active_manifest,
      p.personalization AS current_personalization, scanner.name AS current_scanner_name,
      p.serial AS pass_serial, p.auth_token AS pass_auth_token, p.download_token AS pass_download_token,
      p.web_service_url AS pass_web_service_url, p.scan_code AS pass_scan_code,
      p.external_id AS pass_external_id, p.holder_email AS pass_holder_email,
      ${currentWalletPrivateValuesSql('current_wallet')} AS current_wallet_private_values,
      current_pinned.version AS current_pinned_version, current_pinned.manifest AS current_pinned_manifest,
      current_active.version AS current_active_version, current_active.manifest AS current_active_manifest,
      p.version AS current_pass_version, p.revision AS current_pass_revision,
      p.credential_generation AS current_credential_generation,
      p.lifecycle_generation AS current_lifecycle_generation, p.image_generation AS current_image_generation,
      ${TRANSFER_PENDING} AS current_transfer_pending,
      p.identity_id AS current_identity_id, p.link_generation AS current_link_generation,
      p.connection_id AS current_connection_id, connection.generation AS current_connection_generation,
      org.access_revision AS current_org_revision,
      current_wallet.version AS current_wallet_version, si.revision AS current_identity_revision,
      ar.id AS current_release_id, ar.generation AS current_release_generation,
      ar.candidate_hash AS current_release_hash,
      CASE WHEN p.status = 'active' AND p.deleted_at IS NULL AND p.removed_at IS NULL
        AND p.test_data_quarantined = 0 AND org.status = 'active' AND template.status != 'deleted'
        AND (p.connection_id IS NULL OR connection.id IS NOT NULL)
        AND NOT ${TRANSFER_PENDING}
        AND (ar.id IS NOT NULL OR legacy.version IS NOT NULL)
        AND ${walletSnapshotPredicateSql({ nowSql: '?' })} THEN 1 ELSE 0 END AS projection_current
    FROM scans s
    LEFT JOIN passes p ON p.id = ?/* scan-ephemeral-pass-id */
    LEFT JOIN pass_versions recorded ON recorded.pass_id = p.id AND recorded.version = ?
      AND recorded.version > 0 AND recorded.version <= p.version
    LEFT JOIN template_releases ar ON ar.id = (${usedReleaseIdSql('p')})
    LEFT JOIN template_versions legacy ON legacy.template_id = p.template_id
      AND legacy.version = p.template_version AND p.release_id IS NULL AND ar.id IS NULL
    LEFT JOIN template_versions event_wallet ON event_wallet.template_id = p.template_id
      AND event_wallet.version = recorded.template_version
    LEFT JOIN template_versions current_pinned ON current_pinned.template_id = p.template_id
      AND current_pinned.version = p.template_version
    LEFT JOIN template_versions current_active ON current_active.template_id = p.template_id
      AND current_active.version = COALESCE(ar.version, legacy.version)
    LEFT JOIN pass_versions current_wallet ON current_wallet.pass_id = p.id AND current_wallet.version = (
      SELECT v.version FROM pass_versions v WHERE v.pass_id = p.id AND v.version <= p.version
      ORDER BY v.version DESC LIMIT 1)
    LEFT JOIN signing_identities si ON si.id = p.identity_id AND (si.org_id IS NULL OR si.org_id = p.org_id)
    LEFT JOIN connections connection ON connection.id = p.connection_id
      AND connection.org_id = p.org_id AND connection.enabled = 1
    LEFT JOIN orgs org ON org.id = p.org_id
    LEFT JOIN templates template ON template.id = p.template_id
      AND (template.org_id IS NULL OR template.org_id = p.org_id)
    LEFT JOIN scanners scanner ON scanner.id = s.scanner_id AND scanner.org_id = s.org_id
      AND scanner.mode = s.mode
    WHERE s.id = ?/* scan-ephemeral-scan-id */ AND s.state = 'pending'
      AND s.actor_key = ?/* scan-ephemeral-actor-key */ AND s.org_id = ? AND s.mode = ?
      AND p.org_id = ? AND p.mode = ? AND p.template_id = ?/* scan-ephemeral-template-id */`,
    [
      input.now,
      input.passId,
      input.walletVersion,
      input.scanId,
      input.actorKey,
      input.orgId,
      input.mode,
      input.orgId,
      input.mode,
      input.templateId,
    ],
  );
}
