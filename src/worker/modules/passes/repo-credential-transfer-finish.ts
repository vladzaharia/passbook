import { type Check, passRow, releaseHead, rowIs } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { grantTransferFinish } from '../delivery/repo-issuance.ts';
import { CONFLICT_CODES, transferGrant } from './credential-transfer-grant.ts';
import { transferAssetRetirement } from './repo-credential-transfer-assets.ts';
import {
  eligibleOwner,
  identityRevision,
  noTargetTombstone,
} from './repo-credential-transfer-fences.ts';
import { payloadPart } from './repo-credential-transfer-payload.ts';
import type {
  ConnectionTransferContent,
  CredentialTransferAuthority,
  CredentialTransferTarget,
  TransferPass,
  TransferRow,
} from './repo-credential-transfer-read.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';

export interface FinishTransferInput {
  transfer: TransferRow;
  source: TransferPass;
  release: PassReleaseSnapshot;
  releaseVersion: string;
  serial: string;
  authToken: string;
  scanCode: string;
  barcodeHash: string | null;
  lookupHash: string | null;
  targetRefs: string[];
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  contentHash: string;
  credentialKeysetCommitment: string;
  content: ConnectionTransferContent;
  passJson: string;
  title: string | null;
  subtitle: string | null;
  now: number;
  /** Who started it, when the start's request is also finishing it; otherwise a job finishes. */
  authority?: CredentialTransferAuthority | undefined;
}

function finishChecks(i: FinishTransferInput, target: CredentialTransferTarget): Check[] {
  const { transfer: t, source: s } = i;
  const p = s.pass;
  const connection: Check[] =
    t.source_connection_id === null
      ? []
      : [
          rowIs(
            'passes',
            p.id,
            {
              connection_id: t.source_connection_id,
              external_ref: t.source_connection_ref,
              status: 'active',
              removed_at: null,
              deleted_at: null,
            },
            'lineage',
          ),
          tenantCheck(
            'lineage',
            `EXISTS (SELECT 1 FROM pass_credential_transfer_payloads payload
              JOIN pass_credential_transfers x ON x.id = payload.transfer_id
              WHERE payload.transfer_id = ? AND x.org_id = {org})`,
            [t.id],
          ),
        ];
  return [
    rowIs(
      'pass_credential_transfers',
      t.id,
      {
        pass_id: p.id,
        state: 'pending',
        target_generation: t.target_generation,
        source_lifecycle_generation: t.source_lifecycle_generation,
        source_link_generation: t.source_link_generation,
        target_holder_email: t.target_holder_email,
        target_owner_user_id: t.target_owner_user_id,
      },
      'lineage',
    ),
    ...passRow(p.id, p.rowVersion),
    rowIs(
      'passes',
      p.id,
      {
        credential_generation: t.target_generation,
        lifecycle_generation: t.source_lifecycle_generation,
        link_generation: t.source_link_generation,
        holder_email: p.holderEmail,
        owner_user_id: p.ownerUserId,
        removed_at: p.removedAt,
        deleted_at: null,
        test_data_quarantined: 0,
      },
      'lineage',
    ),
    identityRevision(p.id, s.identityRevision),
    releaseHead(p.templateId, p.mode, 'apple', i.release.id),
    eligibleOwner(p.id, target),
    noTargetTombstone(i.targetRefs),
    ...connection,
  ];
}

/**
 * FINISH, as one grant placed after the completing update. A moved row (`stale`, `lineage`) or a release
 * approved since the rebuild leaves the transfer pending and answers false; the sweep rebuilds.
 */
export async function finishTransferBatch(
  ctx: ServiceContext,
  i: FinishTransferInput,
): Promise<boolean> {
  const { transfer: t, source: s, now } = i;
  const p = s.pass;
  const target: CredentialTransferTarget = {
    holderEmail: t.target_holder_email,
    ownerUserId: t.target_owner_user_id,
  };
  const cause =
    t.requested_by_type === 'api_key'
      ? 'api'
      : t.requested_by_type === 'connection'
        ? 'connection'
        : 'admin';
  const connection = t.source_connection_id !== null;
  if (connection && p.mode !== 'live') return false;
  const g = await transferGrant(ctx, i.authority, 'finish', p, finishChecks(i, target));
  if (!g) return false;
  g.update('passes', {
    set: {
      serial: i.serial,
      auth_token: i.authToken,
      scan_code: i.scanCode,
      barcode_hash: i.barcodeHash,
      lookup_hash: i.lookupHash,
      holder_email: target.holderEmail,
      owner_user_id: target.ownerUserId,
      template_version: i.releaseVersion,
      release_id: i.release.id,
      personalization: JSON.stringify(i.content.personalization),
      field_sources: JSON.stringify(i.content.fieldSources),
      display_title: i.title,
      display_subtitle: i.subtitle,
      object_key: i.objectKey,
      object_sha256: i.objectSha256,
      object_size: i.objectSize,
      content_hash: i.contentHash,
      modified_at: now,
      modified_collision: Math.floor(now / 1000) === Math.floor(p.modifiedAt / 1000) ? 1 : 0,
      removal_published_generation: p.removedAt === null ? null : s.lifecycleGeneration,
      pending_cause: cause,
      pending_actor_type: t.requested_by_type,
      pending_actor_id: t.requested_by_id,
      pending_pass_json: i.passJson,
      pending_source: null,
      ...(connection ? { sync_error_code: null } : {}),
    },
    inc: ['version'],
    where: { id: p.id },
    require: 'one',
    returning: ['id'],
  });
  g.update('pass_credential_transfers', {
    set: { state: 'completed', completed_at: now },
    where: { id: t.id, pass_id: p.id, state: 'pending' },
    require: 'one',
    returning: ['id'],
  });
  transferAssetRetirement(g, {
    transferId: t.id,
    passId: p.id,
    sourceGeneration: s.credentialGeneration,
    now,
  });
  g.add(...grantTransferFinish(g, { passId: p.id, transferId: t.id, objectKey: i.objectKey }));
  if (connection) g.include(payloadPart(g, p.id, 'delete', t.id));
  const event = (kind: string, actorType: string | null, actorId: string | null, data: object) =>
    g.insertSelect(
      'pass_events',
      ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
      [ctx.ids.ordered(now), p.id, kind, null, actorType, actorId, JSON.stringify(data), now],
    );
  event('pass.updated', t.requested_by_type, t.requested_by_id, {
    version: p.version + 1,
    cause,
    source: null,
    notified: false,
  });
  event('push.queued', null, null, { version: p.version + 1, devices: 0 });
  if (
    t.requested_by_type === 'connection' &&
    target.ownerUserId !== null &&
    p.holderEmail !== target.holderEmail
  )
    grantedAudit(g, ctx, {
      orgId: p.orgId,
      actorType: 'connection',
      actorId: t.requested_by_id,
      action: 'holder.attach',
      targetType: 'pass',
      targetId: p.id,
      detail: { via: 'email', userId: target.ownerUserId },
    });
  grantedAudit(g, ctx, {
    orgId: p.orgId,
    actorType: 'system',
    actorId: null,
    action: 'pass.transfer_completed',
    targetType: 'pass',
    targetId: p.id,
    detail: { transferId: t.id, generation: t.target_generation },
  });
  try {
    const result = await g.commit();
    return (result[0]?.results?.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof AppError && CONFLICT_CODES.has(error.code)) return false;
    // Provider retirement is held by the completion trigger, which the grant cannot express as a check.
    if (error instanceof Error && error.message.includes('credential transfer is not ready'))
      return false;
    throw error;
  }
}
