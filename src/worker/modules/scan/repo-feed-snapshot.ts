import type { SqlValue } from '../../platform/db.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { policyCandidateSql } from './repo-feed-select.ts';
import {
  HEX_SLICE,
  privateFields,
  privateIndexes,
  privateValue,
} from './repo-feed-snapshot-fields.ts';
import type { ScanLogRow } from './repo-feed-types.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';

/** Recheck the exact scan, scoped metadata and verified event inputs in one read snapshot. */
function scanLogSnapshotSql(dataSql: string, sliced: ReadonlyMap<number, number>): string {
  const value = (path: string) => {
    const index = privateIndexes.get(path);
    return index === undefined
      ? `json_extract(${dataSql}, '$.row.${path}')`
      : `feed_snapshot.private_${index}`;
  };
  // A value over one slice is compared slice by slice, so no hex string of the whole value is built.
  const equal = (column: string, path: string) => {
    const expected = value(path);
    const index = privateIndexes.get(path);
    if (index === undefined || path === 'amount') return `${column} IS ${expected}`;
    const chars = sliced.get(index);
    if (chars === undefined)
      return `(CASE WHEN ${column} IS NULL THEN ${expected} IS NULL
        ELSE length(CAST(${column} AS BLOB)) * 2 IS length(${expected}) AND hex(${column}) IS ${expected} END)`;
    const bytes = HEX_SLICE / 2;
    const parts = Array.from(
      { length: Math.ceil(chars / HEX_SLICE) },
      (_, part) =>
        `hex(substr(CAST(${column} AS BLOB), ${part * bytes + 1}, ${bytes})) IS feed_snapshot.private_${index}_${part}`,
    );
    return `(CASE WHEN ${column} IS NULL THEN 0
      ELSE length(CAST(${column} AS BLOB)) = ${chars / 2} AND ${parts.join(' AND ')} END)`;
  };
  const now = `json_extract(${dataSql}, '$.now')`;
  const fields = [
    ['s.id', 'id'],
    ['s.org_id', 'orgId'],
    ['s.mode', 'mode'],
    ['s.at', 'at'],
    ['s.outcome', 'outcome'],
    ['s.reason', 'reason'],
    ['s.action_id', 'actionId'],
    ['s.action_kind', 'actionKind'],
    ['s.direction', 'direction'],
    ['s.pass_id', 'passId'],
    ['s.template_id', 'templateId'],
    ['s.method', 'method'],
    ['s.amount', 'amount'],
    ['s.before_value', 'before'],
    ['s.after_value', 'after'],
    ['s.pass_version', 'passVersion'],
    ['s.offline', 'offline'],
    ['s.actor_type', 'actorType'],
    ['s.actor_id', 'actorId'],
    ['s.undone_at', 'undoneAt'],
    ['s.state', 'source.state'],
    ['s.actor_key', 'source.actorKey'],
    ['s.scanner_id', 'source.scannerId'],
    ['s.event_id', 'source.eventId'],
    ['s.staff_id', 'source.staffId'],
    ['s.approved_by', 'source.approvedBy'],
    ['s.override_of', 'source.overrideOf'],
    ['s.undoes', 'source.undoes'],
    ['s.undone_by', 'source.undoneBy'],
    ['s.presence_scope', 'source.presenceScope'],
    ['t.name', 'templateName'],
    ['e.id', 'eventId'],
    ['e.name', 'eventName'],
    ['sc.id', 'scannerId'],
    ['sc.name', 'scannerName'],
    ['st.id', 'staffId'],
    ['st.name', 'staffName'],
    ['ap.name', 'approvedBy'],
    ['undo_target.id', 'undoes'],
  ] as const;
  const keyFields = [
    ['p.id', 'keySnapshot.passId'],
    ['p.org_id', 'keySnapshot.orgId'],
    ['p.mode', 'keySnapshot.mode'],
    ['p.template_id', 'keySnapshot.templateId'],
    ['p.template_version', 'keySnapshot.templateVersion'],
    ['p.release_id', 'keySnapshot.issuanceReleaseId'],
    ['p.version', 'keySnapshot.passVersion'],
    ['p.revision', 'keySnapshot.passRevision'],
    ['p.credential_generation', 'keySnapshot.credentialGeneration'],
    ['p.lifecycle_generation', 'keySnapshot.lifecycleGeneration'],
    ['p.link_generation', 'keySnapshot.linkGeneration'],
    ['p.identity_id', 'keySnapshot.identityId'],
    ['key_identity.revision', 'keySnapshot.identityRevision'],
    ['p.connection_id', 'keySnapshot.connectionId'],
    ['key_connection.generation', 'keySnapshot.connectionGeneration'],
    ['key_org.access_revision', 'keySnapshot.orgRevision'],
    ['key_org.config_revision', 'keySnapshot.templateRevision'],
    ['key_head.id', 'keySnapshot.headId'],
    ['key_head.generation', 'keySnapshot.headGeneration'],
    ['key_head.version', 'keySnapshot.headVersion'],
    ['key_head.candidate_hash', 'keySnapshot.headCandidateHash'],
    ['key_wallet.version', 'keySnapshot.walletVersion'],
    ['key_wallet.template_version', 'keySnapshot.walletTemplateVersion'],
  ] as const;
  const keyExact = keyFields.map(([column, path]) => equal(column, path)).join(' AND\n          ');
  const exact = fields.map(([column, path]) => equal(column, path)).join(' AND\n      ');
  return `EXISTS (
    SELECT 1 FROM scans s
    LEFT JOIN templates t ON t.id=s.template_id AND (t.org_id IS NULL OR t.org_id=s.org_id)
    LEFT JOIN scan_events e ON e.id=s.event_id AND e.org_id=s.org_id AND e.mode=s.mode
      AND (s.pass_id IS NOT NULL OR e.archived_at IS NULL)
    LEFT JOIN scanners sc ON sc.id=s.scanner_id AND sc.org_id=s.org_id AND sc.mode=s.mode
    LEFT JOIN scan_staff st ON st.id=s.staff_id AND st.org_id=s.org_id
    LEFT JOIN scan_staff ap ON ap.id=s.approved_by AND ap.org_id=s.org_id
    LEFT JOIN scans u ON u.id=s.undone_by AND u.org_id=s.org_id AND u.mode=s.mode
    LEFT JOIN scans undo_target ON undo_target.id=s.undoes AND undo_target.org_id=s.org_id AND undo_target.mode=s.mode
    LEFT JOIN scan_staff ust ON ust.id=u.staff_id AND ust.org_id=s.org_id
    LEFT JOIN scanners usc ON usc.id=u.scanner_id AND usc.org_id=s.org_id AND usc.mode=s.mode
    WHERE ${exact}
      AND ${equal(
        `COALESCE(ust.name, usc.name, CASE WHEN u.actor_type='user' THEN 'Admin console' END,
        CASE WHEN u.id IS NOT NULL THEN 'Unknown' END)`,
        'undoneBy',
      )}
      AND ${scanLedgerScopeSql('s')}
      AND ((${value('policyAvailable')} = 0 AND json_type(${dataSql}, '$.row.eventProof') = 'null')
        OR ${policyCandidateSql('s', now)} = 1)
      AND (${value('policyAvailable')} = 0 OR s.pass_id IS NULL OR (
        json_type(${dataSql}, '$.row.keySnapshot') = 'object' AND EXISTS (
          SELECT 1 FROM passes p
          LEFT JOIN signing_identities key_identity ON key_identity.id=p.identity_id
            AND (key_identity.org_id IS NULL OR key_identity.org_id=p.org_id)
          LEFT JOIN pass_versions key_wallet ON key_wallet.pass_id=p.id AND key_wallet.version=(
            SELECT v.version FROM pass_versions v WHERE v.pass_id=p.id AND v.version<=p.version
            ORDER BY v.version DESC LIMIT 1
          )
          LEFT JOIN template_releases key_head ON key_head.id=p.release_id
          LEFT JOIN orgs key_org ON key_org.id=p.org_id
          LEFT JOIN templates key_template ON key_template.id=p.template_id
            AND (key_template.org_id IS NULL OR key_template.org_id=p.org_id)
          LEFT JOIN connections key_connection ON key_connection.id=p.connection_id
            AND key_connection.org_id=p.org_id AND key_connection.enabled=1
          WHERE p.id=s.pass_id AND ${keyExact}
        )
      ))
      AND (json_type(${dataSql}, '$.row.eventProof') = 'null' OR EXISTS (
        SELECT 1 FROM pass_events proof_event
        JOIN pass_versions recorded_version ON recorded_version.pass_id=s.pass_id
          AND recorded_version.version=${value('eventProof.scan.walletVersion')}
          AND recorded_version.version <= s.pass_version
          AND ${equal('recorded_version.template_version', 'eventProof.scan.walletTemplateVersion')}
          AND ${equal('recorded_version.personalization', 'eventProof.versionPersonalization')}
        JOIN template_versions recorded_template ON recorded_template.template_id=s.template_id
          AND ${equal('recorded_template.version', 'eventProof.scan.pinnedTemplateVersion')}
          AND ${equal('recorded_template.manifest', 'eventProof.eventPinnedManifest')}
        LEFT JOIN template_versions wallet_template ON wallet_template.template_id=s.template_id
          AND wallet_template.version=recorded_version.template_version
        LEFT JOIN template_versions event_active ON event_active.template_id=s.template_id
          AND ${equal('event_active.version', 'eventProof.eventActiveVersion')}
        LEFT JOIN template_versions event_legacy ON event_legacy.template_id=s.template_id
          AND ${equal('event_legacy.version', 'eventProof.eventLegacyVersion')}
        JOIN passes current_pass ON current_pass.id=s.pass_id AND current_pass.org_id=s.org_id
          AND current_pass.mode=s.mode AND current_pass.template_id=s.template_id
          AND ${equal('current_pass.personalization', 'eventProof.currentPersonalization')}
        WHERE proof_event.id=(${uniqueScanEventIdSql('s')})
          AND ${equal('proof_event.id', 'eventProof.event.id')}
          AND ${equal('proof_event.org_id', 'eventProof.event.org_id')}
          AND ${equal('proof_event.pass_id', 'eventProof.event.pass_id')}
          AND ${equal('proof_event.mode', 'eventProof.event.mode')}
          AND ${equal('proof_event.kind', 'eventProof.event.kind')}
          AND ${equal('proof_event.device', 'eventProof.event.device')}
          AND ${equal('proof_event.actor_type', 'eventProof.event.actor_type')}
          AND ${equal('proof_event.actor_id', 'eventProof.event.actor_id')}
          AND ${equal('proof_event.data', 'eventProof.event.data')}
          AND ${equal('proof_event.at', 'eventProof.event.at')}
          AND ${equal('wallet_template.version', 'eventProof.eventWalletVersion')}
          AND ${equal('wallet_template.manifest', 'eventProof.eventWalletManifest')}
          AND ${equal('event_active.version', 'eventProof.eventActiveVersion')}
          AND ${equal('event_active.manifest', 'eventProof.eventActiveManifest')}
          AND ${equal('event_legacy.version', 'eventProof.eventLegacyVersion')}
          AND ${equal('event_legacy.manifest', 'eventProof.eventLegacyManifest')}
      ))
  )`;
}

const outputSnapshotSql = scanLogSnapshotSql('feed_snapshot.data', new Map());

/** A parameter-packed extra predicate for a previously projected scan row. */
export function scanLogSnapshotPredicate(
  row: ScanLogRow,
  now: number,
): {
  sql: string;
  params: readonly SqlValue[];
} {
  const key = row.keySnapshot;
  const proof = row.eventProof;
  const metadata = {
    now,
    row: {
      mode: row.mode,
      at: row.at,
      outcome: row.outcome,
      direction: row.direction,
      method: row.method,
      passVersion: row.passVersion,
      offline: row.offline,
      actorType: row.actorType,
      undoneAt: row.undoneAt,
      policyAvailable: row.policyAvailable,
      source: { state: row.source.state },
      keySnapshot:
        key === null
          ? null
          : {
              mode: key.mode,
              passVersion: key.passVersion,
              passRevision: key.passRevision,
              credentialGeneration: key.credentialGeneration,
              lifecycleGeneration: key.lifecycleGeneration,
              linkGeneration: key.linkGeneration,
              identityRevision: key.identityRevision,
              connectionGeneration: key.connectionGeneration,
              orgRevision: key.orgRevision,
              templateRevision: key.templateRevision,
              headGeneration: key.headGeneration,
              walletVersion: key.walletVersion,
            },
      eventProof:
        proof === null
          ? null
          : {
              scan: { walletVersion: proof.scan.walletVersion },
              event: {
                mode: proof.event.mode,
                kind: proof.event.kind,
                actor_type: proof.event.actor_type,
                at: proof.event.at,
              },
            },
    },
  };
  const params: SqlValue[] = [JSON.stringify(metadata)];
  const sliced = new Map<number, number>();
  const privateSelect = privateFields
    .map(([path, label], index) => {
      const value = privateValue(row, path);
      if (value === null || value === undefined) return `NULL AS private_${index}`;
      const marker = `?/* scan-ephemeral-${label} */`;
      if (typeof value !== 'string') {
        params.push(value);
        return `${marker} AS private_${index}`;
      }
      if (value.length <= HEX_SLICE) {
        params.push(value);
        return `${marker} AS private_${index}`;
      }
      sliced.set(index, value.length);
      const parts: string[] = [`NULL AS private_${index}`];
      for (let offset = 0, part = 0; offset < value.length; offset += HEX_SLICE, part++) {
        params.push(value.slice(offset, offset + HEX_SLICE));
        parts.push(`${marker} AS private_${index}_${part}`);
      }
      return parts.join(', ');
    })
    .join(', ');
  const snapshotSql = sliced.size
    ? scanLogSnapshotSql('feed_snapshot.data', sliced)
    : outputSnapshotSql;
  return {
    sql: `EXISTS (SELECT 1 FROM (SELECT json(?) AS data, ${privateSelect}) feed_snapshot WHERE ${snapshotSql})`,
    params,
  };
}
