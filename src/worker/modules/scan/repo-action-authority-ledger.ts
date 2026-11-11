import type { SqlValue } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import type { ActionPassFence } from './repo-pass-authority.ts';
import type { ScanEventRow } from './repo-scope.ts';

type Predicate = { sql: string; params: SqlValue[] };

export interface VerifiedLedgerBinding {
  actionId: string;
  actionIdRef: string;
  event: EventRow;
}

/** A new override requires the exact verified historical event and actor/pass authority. */
export function ledgerAuthorityPredicate(
  actor: ScanActor,
  event: ScanEventRow | null,
  pass: Pass,
  passFence: ActionPassFence,
  scanId: string,
  kind: string,
  wonScanId: string,
  binding: VerifiedLedgerBinding,
): Predicate {
  const selectedEvent = event ?? actor.event;
  if (
    !binding.actionId ||
    !/^[0-9a-f]{64}$/.test(binding.actionIdRef) ||
    binding.event.kind !== kind ||
    binding.event.org_id !== pass.orgId ||
    binding.event.pass_id !== pass.id ||
    binding.event.mode !== pass.mode
  )
    return { sql: '0', params: [] };
  if (
    passFence.credentialGeneration !== pass.credentialGeneration ||
    passFence.lifecycleGeneration !== pass.lifecycleGeneration ||
    passFence.noPendingTransfer !== true
  )
    return { sql: '0', params: [] };
  if (
    pass.releaseId !== null &&
    (typeof pass.releaseId !== 'string' || pass.releaseId.length === 0)
  )
    return { sql: '0', params: [] };
  if (passFence.passJsonHash !== null && typeof passFence.passJsonHash !== 'string')
    return { sql: '0', params: [] };
  if (
    (passFence.personalizationHash !== null &&
      (typeof passFence.personalizationHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(passFence.personalizationHash))) ||
    typeof passFence.evaluatedPersonalizationHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(passFence.evaluatedPersonalizationHash) ||
    !Number.isSafeInteger(passFence.walletVersion) ||
    passFence.walletVersion <= 0 ||
    passFence.walletVersion > pass.version ||
    (passFence.walletTemplateVersion !== null &&
      typeof passFence.walletTemplateVersion !== 'string')
  )
    return { sql: '0', params: [] };
  if (typeof pass.identityId !== 'string') return { sql: '0', params: [] };
  if (
    typeof passFence.identityPassTypeIdentifier !== 'string' ||
    typeof passFence.identityTeamIdentifier !== 'string' ||
    !Number.isSafeInteger(passFence.identityRevision) ||
    passFence.identityRevision <= 0
  )
    return { sql: '0', params: [] };
  const legacy =
    pass.releaseId === null &&
    passFence.activeReleaseId === null &&
    passFence.activeReleaseGeneration === null &&
    passFence.activeReleaseVersion === null &&
    passFence.activeReleaseCandidateHash === null;
  const active =
    typeof passFence.activeReleaseId === 'string' &&
    passFence.activeReleaseId.length > 0 &&
    typeof passFence.activeReleaseGeneration === 'number' &&
    Number.isSafeInteger(passFence.activeReleaseGeneration) &&
    passFence.activeReleaseGeneration > 0 &&
    typeof passFence.activeReleaseVersion === 'string' &&
    passFence.activeReleaseVersion.length > 0 &&
    typeof passFence.activeReleaseCandidateHash === 'string' &&
    passFence.activeReleaseCandidateHash.length > 0;
  if (!legacy && !active) return { sql: '0', params: [] };
  const textType = legacy ? 'null' : 'text';
  const generationType = legacy ? 'null' : 'integer';
  return {
    sql: `EXISTS (SELECT 1 FROM pass_events l
      JOIN scans original ON original.id=?/* scan-ephemeral-scan-id */ AND original.pass_id=l.pass_id
        AND original.org_id=l.org_id AND original.mode=l.mode
        AND original.actor_type IS l.actor_type AND original.actor_id IS l.actor_id
      WHERE l.pass_id=?/* scan-ephemeral-pass-id */ AND l.org_id=? AND l.mode=?
        AND json_extract(l.data,'$.scanId')=original.id AND original.action_id=?/* scan-ephemeral-action-id */
        AND json_type(l.data,'$.actionIdRef')='text' AND json_extract(l.data,'$.actionIdRef')=?
        AND l.id=?/* scan-ephemeral-event-id */ AND l.kind=? AND l.device IS ?/* scan-ephemeral-event-device */ AND l.actor_type IS ? AND l.actor_id IS ?/* scan-ephemeral-event-actor */
        AND l.data=?/* scan-ephemeral-source-event-json */ AND l.at=? AND l.id=${uniqueScanEventIdSql('original')}
        AND json_extract(l.data,'$.authority.linkGeneration')=?
        AND json_type(l.data,'$.authority.credentialGeneration')='integer'
        AND json_extract(l.data,'$.authority.credentialGeneration')=?
        AND json_type(l.data,'$.authority.lifecycleGeneration')='integer'
        AND json_extract(l.data,'$.authority.lifecycleGeneration')=?
        AND json_type(l.data,'$.authority.noPendingTransfer')='true'
        AND json_type(l.data,'$.authority.pinnedReleaseId') IN ('null','text')
        AND json_extract(l.data,'$.authority.pinnedReleaseId') IS ?
        AND json_type(l.data,'$.authority.passJsonHash') IN ('null','text')
        AND json_extract(l.data,'$.authority.passJsonHash') IS ?
        AND json_type(l.data,'$.authority.personalizationHash') IN ('null','text')
        AND json_extract(l.data,'$.authority.personalizationHash') IS ?
        AND json_type(l.data,'$.authority.evaluatedPersonalizationHash')='text'
        AND json_extract(l.data,'$.authority.evaluatedPersonalizationHash')=?
        AND json_type(l.data,'$.authority.walletVersion')='integer'
        AND json_extract(l.data,'$.authority.walletVersion')=?
        AND json_type(l.data,'$.authority.walletTemplateVersion') IN ('null','text')
        AND json_extract(l.data,'$.authority.walletTemplateVersion') IS ?
        AND json_type(l.data,'$.authority.identityId')='text'
        AND json_extract(l.data,'$.authority.identityId')=?
        AND json_type(l.data,'$.authority.identityPassTypeIdentifier')='text'
        AND json_extract(l.data,'$.authority.identityPassTypeIdentifier')=?
        AND json_type(l.data,'$.authority.identityTeamIdentifier')='text'
        AND json_extract(l.data,'$.authority.identityTeamIdentifier')=?
        AND json_type(l.data,'$.authority.identityRevision')='integer'
        AND json_extract(l.data,'$.authority.identityRevision')=?
        AND json_extract(l.data,'$.authority.connectionGeneration') IS ?
        AND json_extract(l.data,'$.authority.activeTemplateVersion')=?
        AND json_type(l.data,'$.authority.activeReleaseId')='${textType}'
        AND json_extract(l.data,'$.authority.activeReleaseId') IS ?
        AND json_type(l.data,'$.authority.activeReleaseGeneration')='${generationType}'
        AND json_extract(l.data,'$.authority.activeReleaseGeneration') IS ?
        AND json_type(l.data,'$.authority.activeReleaseVersion')='${textType}'
        AND json_extract(l.data,'$.authority.activeReleaseVersion') IS ?
        AND json_type(l.data,'$.authority.activeReleaseCandidateHash')='${textType}'
        AND json_extract(l.data,'$.authority.activeReleaseCandidateHash') IS ?
        AND json_extract(l.data,'$.authority.orgRevision')=?
        AND json_extract(l.data,'$.authority.templateRevision')=?
        AND json_extract(l.data,'$.authority.scannerRevision') IS ?
        AND json_extract(l.data,'$.authority.sessionId') IS ?/* scan-ephemeral-session-id */
        AND json_extract(l.data,'$.authority.sessionRevision') IS ?
        AND json_extract(l.data,'$.authority.eventId') IS ?/* scan-ephemeral-event-id */
        AND json_extract(l.data,'$.authority.eventRevision') IS ?
        AND json_extract(l.data,'$.authority.staffId') IS ?/* scan-ephemeral-staff-id */
        AND json_extract(l.data,'$.authority.staffRevision') IS ?
        AND json_extract(l.data,'$.authority.role') IS ?
        AND (json_type(l.data,'$.authority.gate') IS NULL
          OR (json_extract(l.data,'$.authority.gate.exists')=0 AND NOT EXISTS (
            SELECT 1 FROM scan_gates g WHERE g.pass_id=l.pass_id
              AND g.action_id=original.action_id
              AND g.scope=json_extract(l.data,'$.authority.gate.scope')
          ))
          OR (json_extract(l.data,'$.authority.gate.exists')=1 AND EXISTS (
            SELECT 1 FROM scan_gates g LEFT JOIN scans s ON s.id=g.last_scan_id
            WHERE g.pass_id=l.pass_id AND g.action_id=original.action_id
              AND g.scope=json_extract(l.data,'$.authority.gate.scope')
              AND g.last_scan_id IS json_extract(l.data,'$.authority.gate.scanId')
              AND g.state IS json_extract(l.data,'$.authority.gate.state')
              AND g.last_at IS json_extract(l.data,'$.authority.gate.lastAt')
              AND g.count IS json_extract(l.data,'$.authority.gate.count')
              AND s.state IS json_extract(l.data,'$.authority.gate.scanState')
              AND s.undone_by IS json_extract(l.data,'$.authority.gate.undoneBy')
          ))
          OR EXISTS (
            SELECT 1 FROM scan_gates g LEFT JOIN scans s ON s.id=g.prev_scan_id
            WHERE g.pass_id=l.pass_id AND g.action_id=original.action_id
              AND g.scope=json_extract(l.data,'$.authority.gate.scope') AND g.last_scan_id=?/* scan-ephemeral-scan-id */
              AND (
                (json_extract(l.data,'$.authority.gate.exists')=0
                  AND g.prev_state IS NULL AND g.count=1)
                OR (json_extract(l.data,'$.authority.gate.exists')=1
                  AND g.prev_scan_id IS json_extract(l.data,'$.authority.gate.scanId')
                  AND g.prev_state IS json_extract(l.data,'$.authority.gate.state')
                  AND g.prev_last_at IS json_extract(l.data,'$.authority.gate.lastAt')
                  AND g.count=json_extract(l.data,'$.authority.gate.count')+1
                  AND s.state IS json_extract(l.data,'$.authority.gate.scanState')
                  AND s.undone_by IS json_extract(l.data,'$.authority.gate.undoneBy'))
              )
          )))`,
    params: [
      scanId,
      pass.id,
      pass.orgId,
      pass.mode,
      binding.actionId,
      binding.actionIdRef,
      binding.event.id,
      kind,
      binding.event.device,
      binding.event.actor_type,
      binding.event.actor_id,
      binding.event.data,
      binding.event.at,
      pass.linkGeneration,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      pass.releaseId ?? null,
      passFence.passJsonHash,
      passFence.personalizationHash,
      passFence.evaluatedPersonalizationHash,
      passFence.walletVersion,
      passFence.walletTemplateVersion,
      pass.identityId,
      passFence.identityPassTypeIdentifier,
      passFence.identityTeamIdentifier,
      passFence.identityRevision,
      passFence.connectionGeneration,
      passFence.activeTemplateVersion,
      passFence.activeReleaseId,
      passFence.activeReleaseGeneration,
      passFence.activeReleaseVersion,
      passFence.activeReleaseCandidateHash,
      passFence.orgRevision,
      passFence.templateRevision,
      actor.scanner?.updatedAt ?? null,
      actor.scanningSession?.id ?? null,
      actor.scanningSession?.updatedAt ?? null,
      selectedEvent?.id ?? null,
      selectedEvent?.updatedAt ?? null,
      actor.staff?.id ?? null,
      actor.staff?.updatedAt ?? null,
      actor.role,
      wonScanId,
    ],
  };
}
