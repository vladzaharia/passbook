import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { writePart } from '../../platform/authority-include.ts';
import { batch, stmt } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { connectionIs } from '../connections/repo-grants.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { eligibleOwner } from '../passes/repo-credential-transfer-fences.ts';
import { commitRows, noPendingTransfer, tenantPassGrant } from '../passes/repo-pass-grant.ts';
import type { HolderConnectionFence, HolderPass, ReissueSource } from './repo.ts';

export type MutationAudit = { ctx: Pick<ServiceContext, 'clock' | 'requestId'>; entry: AuditEntry };

/** Immediately follows the mutation whose changes() it observes in the same batch. */
export function mutationAudit(db: D1Database, { ctx, entry }: MutationAudit): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO audit_log
       (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    [
      ctx.clock.now(),
      entry.orgId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      ctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
    ],
  );
}

export function operationAuthority(authority: TenantPassWrite): boolean {
  return authority.kind === 'session'
    ? authority.capability === 'passes:operate'
    : authority.scope === 'holders:write' || authority.scope === 'passes:write';
}

/** Trusted callers with no tenant authority; a tenant request takes `removeBlockGranted`. */
export async function removeBlock(
  db: D1Database,
  pass: HolderPass,
  userId: string,
  audit?: MutationAudit,
): Promise<boolean> {
  const deletion = stmt(
    db,
    `DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?
     AND EXISTS (SELECT 1 FROM passes WHERE id = pass_attach_blocks.pass_id
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = passes.id AND t.state = 'pending')
       AND org_id = ? AND mode = ? AND deleted_at IS NULL AND test_data_quarantined = 0)
     RETURNING pass_id`,
    [pass.id, userId, pass.orgId, pass.mode],
  );
  if (!audit) return (await deletion.first<{ pass_id: string }>()) !== null;
  const results = await batch(db, [deletion, mutationAudit(db, audit)]);
  return (results[0]?.results?.length ?? 0) > 0;
}

// Tenant holder writes as grants. Callers with no tenant authority (the attach sweep, sign-in on the
// owner's verified proof, fixtures) keep the trusted writes above and `markHolderReissueRequired`.

/** One write on a live pass of the authority's org and mode, with no transfer pending. */
function holderWriteGrant(
  ctx: ServiceContext,
  purpose: string,
  authority: TenantPassWrite,
  passId: string,
  table: string,
  checks: Check[] = [],
) {
  return tenantPassGrant(
    ctx,
    `org_mode.pass.${purpose}`,
    authority,
    passId,
    [
      rowIs('passes', passId, { deleted_at: null, test_data_quarantined: 0 }),
      noPendingTransfer(passId),
      ...checks,
    ],
    [table],
  );
}

/** Clears one attach block; audited exactly when the block is there to remove. */
export async function removeBlockGranted(
  ctx: ServiceContext,
  pass: HolderPass,
  userId: string,
  authority: TenantPassWrite,
  entry: AuditEntry,
): Promise<boolean> {
  if (!operationAuthority(authority)) return false;
  const g = holderWriteGrant(ctx, 'holder_clear_block', authority, pass.id, 'pass_attach_blocks');
  grantedAudit(g, ctx, entry, [
    tenantSql('EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = ? AND b.user_id = ?)', [
      pass.id,
      userId,
    ]),
  ]);
  const [deleted] = g.include(
    writePart(
      `DELETE FROM pass_attach_blocks WHERE pass_id IN (SELECT p.id FROM passes p
        WHERE p.id = ? AND p.org_id = {org} AND p.mode = {mode}) AND user_id = ? AND {grant}
        RETURNING pass_id`,
      [pass.id, userId],
    ),
  );
  return ((await commitRows(g, deleted)) ?? []).length > 0;
}

/**
 * Records that the verified owner of a waiting pass needs a reissue (its credential cannot rotate),
 * for the exact pass state read. Audited only when the recorded requirement changes. A moved pass
 * records nothing, as the trusted write does.
 */
export async function markHolderReissueGranted(
  ctx: ServiceContext,
  passId: string,
  source: ReissueSource,
  userId: string,
  credentialKeysetCommitment: string,
  authority: TenantPassWrite,
  connection: HolderConnectionFence | undefined,
  entry: AuditEntry,
): Promise<void> {
  if (
    !operationAuthority(authority) ||
    authority.orgId !== source.orgId ||
    authority.mode !== source.mode ||
    source.holderEmail === null ||
    (connection && (connection.orgId !== source.orgId || source.mode !== 'live'))
  )
    return;
  const checks: Check[] = [
    rowIs(
      'passes',
      passId,
      {
        holder_email: source.holderEmail,
        owner_user_id: null,
        version: source.version,
        revision: source.revision,
        credential_generation: source.credentialGeneration,
        lifecycle_generation: source.lifecycleGeneration,
        release_id: source.releaseId,
        download_token: source.downloadToken,
        link_generation: source.linkGeneration,
      },
      'lineage',
    ),
    eligibleOwner(passId, { holderEmail: source.holderEmail, ownerUserId: userId }),
    rawCheck('lineage', credentialRefKeysetSql, [credentialKeysetCommitment]),
  ];
  if (connection)
    checks.push(
      rowIs('passes', passId, {
        connection_id: connection.connectionId,
        external_ref: connection.externalRef,
        status: 'active',
        removed_at: null,
      }),
      connectionIs({
        id: connection.connectionId,
        generation: connection.generation,
        enabled: true,
      }),
    );
  const g = holderWriteGrant(
    ctx,
    'holder_reissue_required',
    authority,
    passId,
    'pass_holder_reissue_required',
    checks,
  );
  grantedAudit(g, ctx, entry, [
    tenantSql(
      `NOT EXISTS (SELECT 1 FROM pass_holder_reissue_required hr
        WHERE hr.pass_id = ? AND hr.user_id = ?
          AND hr.credential_generation = ? AND hr.version = ? AND hr.revision = ?
          AND hr.lifecycle_generation = ? AND hr.link_generation = ? AND hr.release_id IS ?)`,
      [
        passId,
        userId,
        source.credentialGeneration,
        source.version,
        source.revision,
        source.lifecycleGeneration,
        source.linkGeneration,
        source.releaseId,
      ],
    ),
  ]);
  const [marked] = g.include(
    writePart(
      `INSERT INTO pass_holder_reissue_required
        (pass_id, org_id, mode, user_id, credential_generation, version, revision,
         lifecycle_generation, link_generation, release_id, detected_at)
       SELECT p.id, {org}, {mode}, ?, p.credential_generation, p.version, p.revision,
         p.lifecycle_generation, p.link_generation, p.release_id, ?
       FROM passes p WHERE p.id = ? AND p.org_id = {org} AND p.mode = {mode} AND {grant}
       ON CONFLICT(pass_id) DO UPDATE SET user_id = excluded.user_id,
         credential_generation = excluded.credential_generation, version = excluded.version,
         revision = excluded.revision, lifecycle_generation = excluded.lifecycle_generation,
         link_generation = excluded.link_generation, release_id = excluded.release_id,
         detected_at = excluded.detected_at`,
      [userId, ctx.clock.now(), passId],
    ),
  );
  try {
    await commitRows(g, marked);
  } catch (error) {
    // A revoked authority records nothing, as a moved pass does (the trusted write's contract).
    if (!(error instanceof ForbiddenError)) throw error;
    ctx.log.info('holder.reissue_not_recorded', { passId, code: error.code });
  }
}
