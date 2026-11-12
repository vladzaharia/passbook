import type { Grant } from '../../platform/authority.ts';
import { type Check, passRow, releaseHead, rowIs } from '../../platform/authority-checks.ts';
import { exists, notExists } from '../../platform/authority-cond.ts';
import { inList, ne } from '../../platform/authority-expr.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { grantTransferStart } from '../delivery/repo-issuance.ts';
import type { CredentialReference } from './credential-references.ts';
import { transferGrant } from './credential-transfer-grant.ts';
import {
  connectionBound,
  connectionContext,
  eligibleOwner,
  identityRevision,
  noOpenClaims,
  noTargetTombstone,
} from './repo-credential-transfer-fences.ts';
import { passIs, payloadPart } from './repo-credential-transfer-payload.ts';
import type {
  ConnectionTransferBinding,
  CredentialTransferAuthority,
  CredentialTransferTarget,
  TransferPass,
} from './repo-credential-transfer-read.ts';
import { matchesCredentialSource } from './repo-credential-transfer-source.ts';
import type { PassReleaseSnapshot } from './repo-release.ts';

export interface StartTransferInput {
  id: string;
  source: TransferPass;
  target: CredentialTransferTarget;
  authority: CredentialTransferAuthority;
  actor: { type: string; id: string | null };
  token: string;
  now: number;
  release: PassReleaseSnapshot;
  releaseVersion: string;
  tombstones: CredentialReference[];
  targetRefs: string[];
  credentialKeysetCommitment: string;
  connection?: { binding: ConnectionTransferBinding; envelope: Envelope } | undefined;
}

function startChecks(i: StartTransferInput): Check[] {
  const { source: s, target, authority: a } = i;
  const p = s.pass;
  return [
    ...passRow(p.id, p.rowVersion),
    rowIs(
      'passes',
      p.id,
      {
        credential_generation: s.credentialGeneration,
        lifecycle_generation: s.lifecycleGeneration,
        link_generation: p.linkGeneration,
        holder_email: p.holderEmail,
        owner_user_id: p.ownerUserId,
        test_data_quarantined: 0,
      },
      'lineage',
    ),
    ...noOpenClaims(p.id),
    identityRevision(p.id, s.identityRevision),
    eligibleOwner(p.id, target),
    noTargetTombstone(i.targetRefs),
    releaseHead(p.templateId, p.mode, 'apple', i.release.id),
    ...(a.kind === 'connection'
      ? connectionContext(a.connection)
      : i.connection
        ? connectionBound(p.id, i.connection.binding)
        : []),
  ];
}

/** Part writes for the pass's per-device rows: pinned to the pass by `{pass}` (holder) or its id. */
function deviceRows(g: Grant, passId: string, table: string) {
  const at = passIs(g, passId);
  return writePart(`DELETE FROM ${table} WHERE ${at.sql} AND {grant}`, at.params);
}

function writes(g: Grant, ctx: ServiceContext, i: StartTransferInput): void {
  const { source: s, target, authority: a, actor, now } = i;
  const p = s.pass;
  const c = i.connection?.binding;
  g.insertSelect(
    'pass_credential_transfers',
    [
      'id',
      'pass_id',
      'state',
      'source_generation',
      'source_version',
      'source_revision',
      'source_row_version',
      'source_lifecycle_generation',
      'source_link_generation',
      'target_holder_email',
      'target_owner_user_id',
      'requested_by_type',
      'requested_by_id',
      'requested_at',
      'source_connection_id',
      'source_connection_ref',
      'source_connection_generation',
      'source_connection_mode',
      'source_admitted_release_id',
      'source_admitted_release_generation',
      'source_admitted_release_version',
    ],
    [
      i.id,
      p.id,
      'pending',
      s.credentialGeneration,
      p.version,
      p.revision,
      p.rowVersion,
      s.lifecycleGeneration,
      p.linkGeneration + 1,
      target.holderEmail,
      target.ownerUserId,
      actor.type,
      actor.id,
      now,
      c?.connectionId ?? null,
      c?.externalRef ?? null,
      c?.generation ?? null,
      c?.mode ?? null,
      c?.releaseId ?? null,
      c?.releaseGeneration ?? null,
      c?.releaseVersion ?? null,
    ],
    { returning: ['id'] },
  );
  g.update('passes', {
    set: { download_token: i.token, download_token_rotated_at: now },
    inc: ['credential_generation', 'link_generation'],
    where: { id: p.id },
    when: [exists('pass_credential_transfers', { id: i.id, state: 'pending' })],
    require: 'one',
    returning: ['id'],
  });
  g.add(
    ...grantTransferStart(g, {
      passId: p.id,
      transferId: i.id,
      now,
      verifiedAttach: a.kind === 'verified-attach',
    }),
  );
  const env = i.connection?.envelope;
  if (env) g.include(payloadPart(g, p.id, 'insert', i.id, env));
  for (const t of i.tombstones)
    g.insertSelect(
      'pass_credential_tombstones',
      ['pass_id', 'credential_generation', 'credential_kind', 'credential_hash', 'retired_at'],
      [p.id, s.credentialGeneration, t.kind, t.ref, now],
      {
        when: [
          notExists('pass_credential_tombstones', {
            credential_kind: t.kind,
            credential_hash: t.ref,
          }),
        ],
      },
    );
  if (a.kind === 'self-remove')
    g.include(
      writePart(
        'INSERT OR IGNORE INTO pass_attach_blocks (pass_id,user_id,created_at) SELECT {pass},?,? WHERE {grant}',
        [a.userId, now],
      ),
    );
  g.include(deviceRows(g, p.id, 'registrations'), deviceRows(g, p.id, 'pass_personalizations'));
  g.joined('bundle_passes', { via: 'pass_id', where: { pass_id: p.id }, delete: true });
  const cancelled = { state: 'cancelled', finished_at: now, coalesce_key: null, lease: null };
  const open = inList(['pending', 'enqueued']);
  g.update('outbox', {
    set: { ...cancelled, error_code: 'DELIVERY_STALE' },
    where: { pass_id: p.id, kind: 'email', state: open },
  });
  g.update('outbox', { set: cancelled, where: { pass_id: p.id, kind: ne('email'), state: open } });
  g.update('outbox', {
    set: cancelled,
    where: { pass_id: p.id, kind: 'push', state: 'processing' },
  });
  const audit = (entry: AuditEntry) => grantedAudit(g, ctx, entry);
  audit({
    orgId: p.orgId,
    actorType: actor.type as AuditEntry['actorType'],
    actorId: actor.id,
    action: 'pass.transfer_started',
    targetType: 'pass',
    targetId: p.id,
    detail: { transferId: i.id, generation: s.credentialGeneration + 1 },
  });
  if (a.kind === 'self-remove')
    audit({
      orgId: p.orgId,
      actorType: 'user',
      actorId: a.userId,
      action: 'pass.remove_from_user',
      targetType: 'pass',
      targetId: p.id,
      detail: { transferId: i.id, state: 'pending' },
    });
  if (a.kind !== 'session' && a.kind !== 'api_key' && a.audit) audit(a.audit);
}

/**
 * START, as one grant: every precondition is a grant check, evaluated with the writes in one D1 trip. A
 * moved row (`stale`, `lineage`, `config`) answers false; a release approved since the read throws
 * `TEMPLATE_RELEASE_CONFLICT`.
 */
export async function startTransferBatch(
  ctx: ServiceContext,
  input: StartTransferInput,
): Promise<boolean> {
  const { source: s, authority: a } = input;
  const p = s.pass;
  if (a.kind !== 'session' && a.kind !== 'api_key' && !matchesCredentialSource(s, a.expected))
    return false;
  if (a.kind === 'verified-attach' && (p.ownerUserId !== null || p.holderEmail !== a.email))
    return false;
  if ((a.kind === 'connection' || input.connection) && p.mode !== 'live') return false;
  const g = await transferGrant(ctx, a, 'start', p, startChecks(input));
  if (!g) return false;
  writes(g, ctx, input);
  try {
    const result = await g.commit();
    return (result[0]?.results?.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PASS_CONFLICT') return false;
    if (error instanceof Error && error.message.includes('unresolved retained webhook claim')) {
      ctx.log.warn('pass.transfer_blocked', {
        passId: p.id,
        code: 'TRANSFER_RETAINED_CLAIM_UNRESOLVED',
      });
      return false;
    }
    throw error;
  }
}
