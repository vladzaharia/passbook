import { type Check, passRow, rowIs } from '../../platform/authority-checks.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { UnchangedCredential } from './credential-transfer-build.ts';
import { transferGrant } from './credential-transfer-grant.ts';
import {
  attachBlockPart,
  connectionBound,
  eligibleOwner,
  noOpenClaims,
  noTargetTombstone,
} from './repo-credential-transfer-fences.ts';
import {
  type CredentialTransferAuthority,
  readTransferConnection,
} from './repo-credential-transfer-read.ts';
import { matchesCredentialSource } from './repo-credential-transfer-source.ts';

type VerifiedAttach = Extract<CredentialTransferAuthority, { kind: 'verified-attach' }>;

/**
 * A verified attach whose credential cannot change: the sign-in already proves the holder, so the
 * pass is linked to the account as it is, in one grant, with no rotation, tombstone or new artifact.
 * False when the pass, the account or the connection moved since the read.
 */
export async function linkVerifiedAttach(
  ctx: ServiceContext,
  a: VerifiedAttach,
  unchanged: UnchangedCredential,
): Promise<boolean> {
  const { source: s, stableRefs } = unchanged;
  const p = s.pass;
  if (
    !matchesCredentialSource(s, a.expected) ||
    p.ownerUserId !== null ||
    p.holderEmail !== a.email
  )
    return false;
  const checks: Check[] = [
    ...passRow(p.id, p.rowVersion),
    rowIs(
      'passes',
      p.id,
      {
        credential_generation: s.credentialGeneration,
        lifecycle_generation: s.lifecycleGeneration,
        link_generation: p.linkGeneration,
        holder_email: p.holderEmail,
        owner_user_id: null,
        test_data_quarantined: 0,
      },
      'lineage',
    ),
    ...noOpenClaims(p.id),
    eligibleOwner(p.id, { holderEmail: a.email, ownerUserId: a.userId }),
    noTargetTombstone(stableRefs),
  ];
  const c = a.connection;
  if (c) {
    const current = await readTransferConnection(ctx.env.DB, p.orgId, c.connectionId);
    if (!current || current.generation !== c.generation || c.orgId !== p.orgId || p.mode !== 'live')
      return false;
    checks.push(
      ...connectionBound(p.id, {
        connectionId: c.connectionId,
        externalRef: c.externalRef,
        generation: c.generation,
        mode: current.mode,
      }),
    );
  }
  const g = await transferGrant(ctx, a, 'start', p, checks);
  if (!g) return false;
  g.update('passes', {
    set: { owner_user_id: a.userId },
    where: { id: p.id, owner_user_id: null },
    require: 'one',
    returning: ['id'],
  });
  if (a.audit) grantedAudit(g, ctx, { ...a.audit, detail: { ...a.audit.detail, rotated: false } });
  try {
    const result = await g.commit();
    return (result[0]?.results?.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PASS_CONFLICT') return false;
    throw error;
  }
}

type SelfRemove = Extract<CredentialTransferAuthority, { kind: 'self-remove' }>;

/**
 * The owner removes a pass whose credential cannot change: block re-attachment and clear the owner in
 * one grant, with no rotation. False when the pass or the owner's session moved since the read.
 */
export async function unlinkSelfRemove(
  ctx: ServiceContext,
  a: SelfRemove,
  unchanged: UnchangedCredential,
): Promise<boolean> {
  const { source: s, stableRefs } = unchanged;
  const p = s.pass;
  if (!matchesCredentialSource(s, a.expected) || p.ownerUserId !== a.userId) return false;
  const g = await transferGrant(ctx, a, 'start', p, [
    ...passRow(p.id, p.rowVersion),
    rowIs(
      'passes',
      p.id,
      {
        credential_generation: s.credentialGeneration,
        lifecycle_generation: s.lifecycleGeneration,
        link_generation: p.linkGeneration,
        holder_email: p.holderEmail,
        owner_user_id: a.userId,
        test_data_quarantined: 0,
      },
      'lineage',
    ),
    ...noOpenClaims(p.id),
    noTargetTombstone(stableRefs),
  ]);
  if (!g) return false;
  g.include(attachBlockPart(a.userId, ctx.clock.now()));
  g.update('passes', {
    set: { owner_user_id: null },
    where: { id: p.id, owner_user_id: a.userId },
    require: 'one',
    returning: ['id'],
  });
  if (a.audit) grantedAudit(g, ctx, { ...a.audit, detail: { ...a.audit.detail, rotated: false } });
  try {
    await g.commit();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'PASS_CONFLICT') return false;
    throw error;
  }
}
