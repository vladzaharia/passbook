import { stmt } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { recordedScanProvenanceSql, uniqueScanEventIdSql } from './repo-history-provenance.ts';

const recordedProof = recordedScanProvenanceSql({
  scanAlias: 'q',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: "json_extract(l.data,'$.authority.pinnedTemplateVersion')",
  walletVersionSql: 'recorded.version',
  walletTemplateVersionSql: 'recorded.template_version',
});

/** Capture the target together with its original signed event and wallet version. */
export function overrideEvidenceForTargetStmt(
  db: D1Database,
  actor: ScanActor,
  targetId: string,
  since: number,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT q.*,
    EXISTS (SELECT 1 FROM scans o WHERE o.actor_key=?/* scan-ephemeral-actor-key */
      AND o.at>=? AND o.override_of=?/* scan-ephemeral-scan-id */ AND o.outcome='ok') AS taken,
    l.id AS evidence_id,l.org_id AS evidence_org_id,l.pass_id AS evidence_pass_id,l.mode AS evidence_mode,
    l.kind AS evidence_kind,l.device AS evidence_device,l.actor_type AS evidence_actor_type,
    l.actor_id AS evidence_actor_id,l.data AS evidence_data,l.at AS evidence_at,
    CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.pinnedTemplateVersion') END AS pinned_version,
    recorded.version AS wallet_version,recorded.template_version AS wallet_template_version,
    CASE WHEN json_valid(l.data) THEN CASE WHEN (${recordedProof}) THEN 1 ELSE 0 END ELSE 0 END AS approved_proof
    FROM scans q JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}
    JOIN pass_versions recorded ON recorded.pass_id=q.pass_id
      AND recorded.version=CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.walletVersion') END
      AND recorded.version<=q.pass_version
      AND recorded.version=(SELECT v.version FROM pass_versions v
        WHERE v.pass_id=q.pass_id AND v.version<=q.pass_version ORDER BY v.version DESC LIMIT 1)
    WHERE q.id=?/* scan-ephemeral-scan-id */ AND q.org_id=? AND q.mode=?
      AND q.actor_key=?/* scan-ephemeral-actor-key */ AND q.state='done' AND q.outcome='heads_up'
      AND q.at>=? AND q.actor_type=l.actor_type AND q.actor_id=l.actor_id`,
    [actor.actorKey, since, targetId, targetId, actor.orgId, actor.mode, actor.actorKey, since],
  );
}
