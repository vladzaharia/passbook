import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import {
  addBlockAndClearOwner,
  attachOwner,
  attachWaiting,
  blockedUserIds,
  blockedUsers,
  getHolderPass,
  getHolderPasses,
  type HolderPass,
  isOwner,
  listHolderPasses,
  reassign,
  removeBlock,
  setEmailIfUnowned,
  userVerifiedEmail,
  verifiedCandidates,
} from './repo.ts';

type HolderState = 'unassigned' | 'waiting' | 'owned';

const stateOf = (p: HolderPass): HolderState =>
  p.ownerUserId ? 'owned' : p.holderEmail ? 'waiting' : 'unassigned';

function toHolder(p: HolderPass, blocked: string[]) {
  return {
    passId: p.id,
    state: stateOf(p),
    email: p.holderEmail,
    ownerUserId: p.ownerUserId,
    ownerName: p.ownerName,
    blockedUserIds: blocked,
    updatedAt: p.modifiedAt,
  };
}

function emailOf(raw: string): string {
  const email = strictEmail(raw);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  return email;
}

async function load(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await getHolderPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  assertWritableMode(scope, pass.mode);
  return pass;
}

async function view(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await load(ctx, passId, scope);
  return toHolder(pass, await blockedUserIds(ctx.env.DB, passId));
}

/**
 * Hook A: a pass has (or changed) a holder email. The same three statements run whether or not
 * an account verified the address; ambiguity (two accounts) leaves the pass waiting.
 */
export async function runAttachHookA(
  ctx: ServiceContext,
  passId: string,
  actor: Actor = { type: 'system', id: null },
): Promise<boolean> {
  const pass = await getHolderPass(ctx.env.DB, passId, null);
  const email = pass?.holderEmail ?? null;
  const [candidates, blocked] = await Promise.all([
    verifiedCandidates(ctx.env.DB, email ?? ''),
    blockedUserIds(ctx.env.DB, passId),
  ]);
  const eligible = candidates.filter((id) => !blocked.includes(id));
  const chosen = pass && !pass.ownerUserId && eligible.length === 1 ? (eligible[0] ?? null) : null;
  const attached = await attachOwner(ctx.env.DB, passId, chosen, email);
  if (attached && pass) {
    await recordAudit(ctx, {
      orgId: pass.orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'holder.attach',
      targetType: 'pass',
      targetId: passId,
      detail: { via: 'email', userId: chosen },
    });
  }
  return attached;
}

async function assignOne(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string },
  pass: HolderPass,
): Promise<void> {
  const email = emailOf(input.email);
  if (pass.holderEmail === email) return;
  if (pass.ownerUserId) throw new ConflictError('The pass is owned. Use reassign.', 'HOLDER_OWNED');
  if (!(await setEmailIfUnowned(ctx.env.DB, pass.id, email)))
    throw new ConflictError('The pass was claimed meanwhile. Reload.', 'HOLDER_CHANGED');
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.assign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { changed: true },
  });
  await runAttachHookA(ctx, pass.id, actor);
}

export async function assignHolder(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string },
  scope: ScopeArg,
) {
  await assignOne(ctx, actor, input, await load(ctx, input.passId, scope));
  return view(ctx, input.passId, scope);
}

export async function assignHoldersBulk(
  ctx: ServiceContext,
  actor: Actor,
  items: { passId: string; email: string }[],
  scope: ScopeArg,
) {
  // Scope and validate everything first: a foreign pass must not leave earlier items applied.
  const passes = await getHolderPasses(
    ctx.env.DB,
    items.map((i) => i.passId),
    scope,
  );
  for (const item of items) {
    emailOf(item.email);
    const found = passes.get(item.passId);
    if (!found) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    assertWritableMode(scope, found.mode);
  }
  for (const item of items) {
    const pass = (await getHolderPass(ctx.env.DB, item.passId, scope)) ?? passes.get(item.passId);
    if (pass) await assignOne(ctx, actor, item, pass);
  }
  const after = await getHolderPasses(
    ctx.env.DB,
    items.map((i) => i.passId),
    scope,
  );
  const blocks = await blockedUsers(ctx.env.DB, [...after.keys()]);
  return items.flatMap((item) => {
    const pass = after.get(item.passId);
    return pass ? [toHolder(pass, blocks.get(pass.id) ?? [])] : [];
  });
}

/** Explicit admin move of an owned pass: clears the owner, sets the email, then runs hook A. */
export async function reassignHolder(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string | null },
  scope: ScopeArg,
) {
  const email = input.email === null ? null : emailOf(input.email);
  const pass = await load(ctx, input.passId, scope);
  await reassign(ctx.env.DB, pass.id, email);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.reassign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { fromUserId: pass.ownerUserId },
  });
  await runAttachHookA(ctx, pass.id, actor);
  return view(ctx, pass.id, scope);
}

export async function unassignHolder(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
) {
  const pass = await load(ctx, passId, scope);
  await reassign(ctx.env.DB, pass.id, null);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.unassign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { fromUserId: pass.ownerUserId },
  });
  return view(ctx, pass.id, scope);
}

export async function clearBlock(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; userId: string },
  scope: ScopeArg,
): Promise<void> {
  const pass = await load(ctx, input.passId, scope);
  const removed = await removeBlock(ctx.env.DB, pass.id, input.userId);
  if (!removed) throw new NotFoundError('Block not found.', 'BLOCK_NOT_FOUND');
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.clear_block',
    targetType: 'pass',
    targetId: pass.id,
    detail: { userId: input.userId },
  });
  // The block was the only thing stopping a waiting pass from attaching.
  await runAttachHookA(ctx, pass.id, actor);
}

export async function listHolders(
  ctx: ServiceContext,
  filter: {
    email?: string;
    state?: HolderState;
    orgId?: string | null;
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

/**
 * Hook B: after `userId` verifies `email`, attach every waiting, unblocked pass with that holder email.
 * Returns the number of passes attached.
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
  const attached = await attachWaiting(ctx.env.DB, userId, normalized);
  for (const pass of attached) {
    await recordAudit(ctx, {
      orgId: pass.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'holder.attach',
      targetType: 'pass',
      targetId: pass.id,
      detail: { via: 'email', userId },
    });
  }
  return attached.length;
}

/** "Remove from my passes": write the attach block, then clear the owner. */
export async function removePassFromUser(
  ctx: ServiceContext,
  passId: string,
  userId: string,
): Promise<void> {
  if (!(await isOwner(ctx.env.DB, passId, userId))) return;
  const cleared = await addBlockAndClearOwner(ctx.env.DB, passId, userId, ctx.clock.now());
  if (!cleared) return;
  const pass = await getHolderPass(ctx.env.DB, passId, null);
  await recordAudit(ctx, {
    orgId: pass?.orgId ?? null,
    actorType: 'user',
    actorId: userId,
    action: 'holder.remove',
    targetType: 'pass',
    targetId: passId,
    detail: { block: true },
  });
}
