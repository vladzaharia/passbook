import type { Mode } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { blockedUserIds, getHolderPass, type HolderPass, verifiedCandidates } from './repo.ts';

export type HolderState = 'unassigned' | 'waiting' | 'owned';
export type HolderAuthority = (orgId: string) => Promise<TenantPassWrite>;
export type TransferResult = { transferId: string; state: 'pending' | 'completed' };

export function toHolder(p: HolderPass, blocked: string[], transfer?: TransferResult | null) {
  const state: HolderState = p.ownerUserId ? 'owned' : p.holderEmail ? 'waiting' : 'unassigned';
  return {
    passId: p.id,
    state,
    email: p.holderEmail,
    ownerUserId: p.ownerUserId,
    ownerName: p.ownerName,
    blockedUserIds: blocked,
    transfer: p.pendingTransferId
      ? { transferId: p.pendingTransferId, state: 'pending' as const }
      : (transfer ?? null),
    reissueRequired: p.reissueRequired,
    updatedAt: p.modifiedAt,
  };
}

export function emailOf(raw: string): string {
  const email = strictEmail(raw);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  return email;
}

export async function load(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await getHolderPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

export async function view(
  ctx: ServiceContext,
  passId: string,
  scope: ScopeArg,
  orgId: string,
  mode: Mode,
  transfer?: TransferResult | null,
) {
  const pass = await load(ctx, passId, scope);
  if (pass.orgId !== orgId || pass.mode !== mode)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return toHolder(pass, await blockedUserIds(ctx.env.DB, passId), transfer);
}

export function assertNoTransfer(pass: HolderPass) {
  if (pass.pendingTransferId)
    throw new ConflictError('A holder transfer is already pending.', 'HOLDER_TRANSFER_PENDING');
}

export async function eligibleOwner(ctx: ServiceContext, passId: string, email: string | null) {
  if (!email) return null;
  const [candidates, blocked] = await Promise.all([
    verifiedCandidates(ctx.env.DB, email),
    blockedUserIds(ctx.env.DB, passId),
  ]);
  const eligible = candidates.filter((id) => !blocked.includes(id));
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

export async function changeHolder(
  ctx: ServiceContext,
  actor: Actor,
  pass: HolderPass,
  email: string | null,
  scope: ScopeArg,
  authority: TenantPassWrite | undefined,
  audit: AuditEntry,
): Promise<TransferResult> {
  assertNoTransfer(pass);
  const ownerUserId = await eligibleOwner(ctx, pass.id, email);
  try {
    return await startCredentialTransfer(
      ctx,
      actor,
      pass.id,
      { holderEmail: email, ownerUserId },
      scope,
      { kind: 'tenant-holder', expected: pass, ...(authority ? { authority } : {}), audit },
    );
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'PASS_CONFLICT')
      throw new ConflictError('The pass changed meanwhile. Reload.', 'HOLDER_CHANGED');
    throw error;
  }
}

export async function assignOne(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string; email: string },
  pass: HolderPass,
  scope: ScopeArg,
  authority?: TenantPassWrite,
): Promise<TransferResult | null> {
  const email = emailOf(input.email);
  assertNoTransfer(pass);
  if (pass.holderEmail === email) return null;
  if (pass.ownerUserId) throw new ConflictError('The pass is owned. Use reassign.', 'HOLDER_OWNED');
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.assign',
    targetType: 'pass',
    targetId: pass.id,
    detail: { changed: true },
  };
  return changeHolder(ctx, actor, pass, email, scope, authority, audit);
}

export async function preflightAssignments(
  items: { passId: string; email: string }[],
  passes: Map<string, HolderPass>,
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  // Scope and validate everything first: a foreign pass must not leave earlier items applied.
  const authorities = new Map<string, TenantPassWrite>();
  for (const item of items) {
    emailOf(item.email);
    const found = passes.get(item.passId);
    if (!found) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    if (authorize && !authorities.has(found.orgId))
      authorities.set(found.orgId, await authorize(found.orgId));
    assertWritableMode(scope, found.mode);
  }
  return authorities;
}
