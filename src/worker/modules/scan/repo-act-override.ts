import { stmt } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { overrideScopeSql } from './override-scope.ts';
import { recordedScanProvenanceSql, uniqueScanEventIdSql } from './repo-history-provenance.ts';

const recordedProof = recordedScanProvenanceSql({
  scanAlias: 'q',
  ledgerAlias: 'l',
  recordedTemplateVersionSql: "json_extract(l.data,'$.authority.pinnedTemplateVersion')",
  walletVersionSql: 'recorded.version',
  walletTemplateVersionSql: 'recorded.template_version',
});

/** The refusing door's settings now: its current session, else the scan's session, else the device. Unreadable reads as the strictest. */
const doorSettings = `COALESCE(
  (SELECT s.settings FROM scanning_devices dv JOIN scanning_sessions s ON s.id=dv.session_id WHERE dv.scanner_id=q.scanner_id),
  (SELECT s.settings FROM scanning_sessions s WHERE s.id=q.session_id),
  (SELECT d.settings FROM scanners d WHERE d.id=q.scanner_id))`;

/** The door's own switch, the scan's event, or its zone or any zone above it: Full is final. */
const hardLimitSql = `MAX(
  COALESCE(CASE WHEN json_valid(${doorSettings}) THEN json_extract(${doorSettings},'$.hardLimit') END, 0),
  COALESCE((SELECT e.hard_limit FROM scan_events e WHERE e.id=q.event_id AND e.org_id=q.org_id), 0),
  COALESCE((WITH RECURSIVE up(id, parent_id, hard_limit) AS (
      SELECT z.id, z.parent_id, z.hard_limit FROM scan_zones z WHERE z.id=q.zone_id AND z.org_id=q.org_id
      UNION ALL SELECT z.id, z.parent_id, z.hard_limit FROM scan_zones z JOIN up ON z.id=up.parent_id AND z.org_id=q.org_id)
    SELECT MAX(hard_limit) FROM up), 0))`;

/** Capture the target together with its original signed event and wallet version. */
export function overrideEvidenceForTargetStmt(
  db: D1Database,
  actor: ScanActor,
  targetId: string,
  since: number,
): D1PreparedStatement {
  const scope = overrideScopeSql(actor);
  return stmt(
    db,
    `SELECT q.*,
    EXISTS (SELECT 1 FROM scans o WHERE o.at>=? AND o.override_of=? AND o.outcome='ok'
      AND o.state='done' AND o.undone_at IS NULL) AS taken,
    COALESCE(CASE WHEN json_valid(${doorSettings}) THEN json_extract(${doorSettings},'$.letInAgain') END,'manager') AS door_let_in_again,
    ${hardLimitSql} AS door_hard_limit,
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
    WHERE q.id=? AND q.org_id=? AND q.mode=?
      AND ${scope.sql} AND q.state='done' AND q.outcome IN ('heads_up','refused')
      AND q.at>=? AND q.actor_type=l.actor_type AND q.actor_id=l.actor_id`,
    [since, targetId, targetId, actor.orgId, actor.mode, ...scope.params, since],
  );
}
