import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { linkVerifiedAttach } from '../passes/credential-link.ts';
import {
  type CredentialTransferAuthority,
  CredentialTransferReissueRequired,
  type CredentialTransferSource,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import {
  blockedUserIds,
  blockedUsers,
  getHolderPass,
  type HolderConnectionFence,
  markHolderReissueRequired,
} from './repo.ts';
import { removeBlock } from './repo-blocks.ts';
import {
  getHolderPasses,
  listHolderPasses,
  userVerifiedEmail,
  waitingPassIds,
} from './repo-queries.ts';
import {
  assertNoTransfer,
  assignOne,
  changeHolder,
  eligibleOwner,
  emailOf,
  type HolderAuthority,
  type HolderState,
  load,
  preflightAssignments,
  type TransferResult,
  toHolder,
  view,
} from './service-operations.ts';

/**
 * Hook A stages a transfer to the unique verified, unblocked account. The returned lineage
 * distinguishes a pending retirement from a completed attachment.
 */
export async function runAttachHookA(
  ctx: ServiceContext,
  passId: string,
  actor: Actor = { type: 'system', id: null },
  options?: {
    authority?: TenantPassWrite | undefined;
    connection?: HolderConnectionFence | undefined;
    expectedSource?: CredentialTransferSource | undefined;
    expectedUserId?: string | undefined;
  },
): Promise<
  (Omit<TransferResult, 'transferId'> & { transferId: string | null; ownerUserId: string }) | null
> {
  const pass = await getHolderPass(ctx.env.DB, passId, null);
  if (!pass?.holderEmail || pass.ownerUserId || pass.pendingTransferId) return null;
  const email = pass.holderEmail;
  const chosen = await eligibleOwner(ctx, passId, email);
  if (!chosen || (options?.expectedUserId && options.expectedUserId !== chosen)) return null;
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.attach',
    targetType: 'pass',
    targetId: passId,
    detail: { via: 'email', userId: chosen },
  };
  const authority: CredentialTransferAuthority & { kind: 'verified-attach' } = {
    kind: 'verified-attach',
    expected: options?.expectedSource ?? pass,
    userId: chosen,
    email,
    ...(options?.authority ? { authority: options.authority } : {}),
    ...(options?.connection ? { connection: options.connection } : {}),
    audit,
  };
  try {
    try {
      const transfer = await startCredentialTransfer(
        ctx,
        actor,
        passId,
        { holderEmail: email, ownerUserId: chosen },
        null,
        authority,
      );
      return { ...transfer, ownerUserId: chosen };
    } catch (error) {
      if (!(error instanceof CredentialTransferReissueRequired && error.unchanged)) throw error;
      // The credential cannot change, so the verified owner is linked to the pass as it is.
      return (await linkVerifiedAttach(ctx, authority, error.unchanged))
        ? { transferId: null, state: 'completed', ownerUserId: chosen }
        : null;
    }
  } catch (error) {
    if (error instanceof CredentialTransferReissueRequired) {
      await markHolderReissueRequired(
        ctx.env.DB,
        passId,
        options?.expectedSource ?? pass,
        chosen,
        ctx.clock.now(),
        error.credentialKeysetCommitment,
        options?.authority,
        options?.connection,
        {
          ctx,
          entry: { ...audit, action: 'holder.attach_reissue_required', detail: { userId: chosen } },
        },
      );
      return null;
    }
    if (
      error instanceof ConflictError &&
      (error.code === 'PASS_CONFLICT' || error.code === 'HOLDER_TRANSFER_PENDING')
    )
      return null;
    // The owner's own proof no longer holds (blocked, disabled, unverified, pass voided or org changed):
    // nothing attaches. A revoked tenant authority is a 403 the caller must see.
    if (
      !options?.authority &&
      error instanceof ForbiddenError &&
      (error.code === 'ACTOR_CHANGED' || error.code === 'ORG_ACCESS_CHANGED')
    )
      return null;
    throw error;
  }
}

export async function assignHolder(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string },
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  const pass = await load(ctx, input.passId, scope);
  const authority = await authorize?.(pass.orgId);
  assertWritableMode(scope, pass.mode);
  const transfer = await assignOne(ctx, actor, input, pass, scope, authority);
  return view(ctx, input.passId, scope, pass.orgId, pass.mode, transfer);
}

export async function assignHoldersBulk(
  ctx: ServiceContext,
  actor: Actor,
  items: { passId: string; email: string }[],
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  const passes = await getHolderPasses(
    ctx.env.DB,
    items.map((i) => i.passId),
    scope,
  );
  const authorities = await preflightAssignments(items, passes, scope, authorize);
  const transfers = new Map<string, TransferResult | null>();
  for (const item of items) {
    const original = passes.get(item.passId);
    if (!original) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    const pass = await getHolderPass(ctx.env.DB, item.passId, scope);
    if (!pass || pass.orgId !== original.orgId)
      throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    assertWritableMode(scope, pass.mode);
    transfers.set(
      pass.id,
      await assignOne(ctx, actor, item, pass, scope, authorities.get(pass.orgId)),
    );
  }
  const after = await getHolderPasses(
    ctx.env.DB,
    items.map((i) => i.passId),
    scope,
  );
  const blocks = await blockedUsers(ctx.env.DB, [...after.keys()]);
  return items.flatMap((item) => {
    const pass = after.get(item.passId);
    const original = passes.get(item.passId);
    return pass && original && pass.orgId === original.orgId && pass.mode === original.mode
      ? [toHolder(pass, blocks.get(pass.id) ?? [], transfers.get(pass.id))]
      : [];
  });
}

/** Explicit admin transfer, including clearing the holder when email is null. */
export async function reassignHolder(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string | null },
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  const email = input.email === null ? null : emailOf(input.email);
  const pass = await load(ctx, input.passId, scope);
  const authority = await authorize?.(pass.orgId);
  assertWritableMode(scope, pass.mode);
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.reassign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { fromUserId: pass.ownerUserId },
  };
  const transfer = await changeHolder(ctx, actor, pass, email, scope, authority, audit);
  return view(ctx, pass.id, scope, pass.orgId, pass.mode, transfer);
}

export async function unassignHolder(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  const pass = await load(ctx, passId, scope);
  const authority = await authorize?.(pass.orgId);
  assertWritableMode(scope, pass.mode);
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.unassign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { fromUserId: pass.ownerUserId },
  };
  const transfer = await changeHolder(ctx, actor, pass, null, scope, authority, audit);
  return view(ctx, pass.id, scope, pass.orgId, pass.mode, transfer);
}

export async function clearBlock(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; userId: string },
  scope: ScopeArg,
  authorize?: HolderAuthority,
): Promise<void> {
  const pass = await load(ctx, input.passId, scope);
  const authority = await authorize?.(pass.orgId);
  assertWritableMode(scope, pass.mode);
  assertNoTransfer(pass);
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.clear_block',
    targetType: 'pass',
    targetId: pass.id,
    detail: { userId: input.userId },
  };
  const removed = await removeBlock(ctx.env.DB, pass, input.userId, authority, ctx.clock.now(), {
    ctx,
    entry: audit,
  });
  if (!removed) throw new NotFoundError('Block not found.', 'BLOCK_NOT_FOUND');
  // The block was the only thing stopping a waiting pass from attaching.
  await runAttachHookA(ctx, pass.id, actor, { authority });
}

export async function listHolders(
  ctx: ServiceContext,
  filter: {
    email?: string;
    state?: HolderState;
    orgId: string;
    mode?: Mode;
    cursor?: string;
    limit: number;
  },
) {
  const email = filter.email ? strictEmail(filter.email) : undefined;
  if (filter.email && !email) return { items: [], nextCursor: null };
  const page = await listHolderPasses(ctx.env.DB, { ...filter, ...(email ? { email } : {}) });
  const blocks = await blockedUsers(
    ctx.env.DB,
    page.items.map((p) => p.id),
  );
  return {
    items: page.items.map((p) => toHolder(p, blocks.get(p.id) ?? [])),
    nextCursor: page.nextCursor,
  };
}

export async function getHolder(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  return toHolder(await load(ctx, passId, scope), await blockedUserIds(ctx.env.DB, passId));
}

/**
 * Hook B: stage transfers for waiting passes after the caller verifies the address.
 * Returns the number of transfers started, including those still pending provider retirement.
 */
export async function attachWaitingPassesForEmail(
  ctx: ServiceContext,
  userId: string,
  email: string,
): Promise<number> {
  const normalized = strictEmail(email);
  // The caller's word is not proof: the address must be verified for this user right now.
  const verified = await userVerifiedEmail(ctx.env.DB, userId, normalized ?? '');
  if (!normalized || !verified) return 0;
  const ids = await waitingPassIds(ctx.env.DB, normalized);
  let started = 0;
  for (const id of ids) {
    if (await runAttachHookA(ctx, id, { type: 'user', id: userId }, { expectedUserId: userId }))
      started++;
  }
  return started;
}
