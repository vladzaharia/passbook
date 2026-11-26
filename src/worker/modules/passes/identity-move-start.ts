import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { sendOperationRun } from '../operations/jobs.ts';
import { startOperation } from '../operations/start.ts';
import { depsOf } from './deps.ts';
import { dropOrphanParams, insertParams } from './repo-identity-move.ts';
import { countCandidates, type MoveCounts } from './repo-identity-move-candidates.ts';
import { getOrg } from './repo-read-issuance.ts';

export interface MoveInput {
  orgId: string;
  fromIdentityId: string;
  /** Default: the org's current issuing identity. */
  toIdentityId?: string | null;
  /** A caller-derived operation id (`operationIdFor`): a repeat of the same start answers the same operation. */
  id?: string;
}

/** The identities and the org of a move, refused early: a move to an identity that cannot issue never starts. */
async function checked(ctx: ServiceContext, input: MoveInput, keyless = false) {
  const org = await getOrg(ctx.env.DB, input.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const { identities } = depsOf(ctx.env);
  // A dry run reads metadata only: the signing key is checked when the move starts and when it issues.
  const peek = keyless && identities.peekById && identities.peekForOrg;
  const from = peek
    ? await identities.peekById?.(input.fromIdentityId)
    : await identities.byId(input.fromIdentityId);
  const to = peek
    ? await identities.peekForOrg?.(input.orgId, input.toIdentityId, ctx.clock.now())
    : await identities.forOrg(input.orgId, input.toIdentityId, ctx.clock.now());
  if (!from || !to) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (from.id === to.id)
    throw new ConflictError('The passes are already on that identity.', 'IDENTITY_MOVE_SAME');
  return { fromId: from.id, toId: to.id };
}

/** The dry run: what a move would touch. Nothing is written. */
export async function previewIdentityMove(
  ctx: ServiceContext,
  input: MoveInput,
): Promise<MoveCounts & { toIdentityId: string }> {
  const { fromId, toId } = await checked(ctx, input, true);
  return { ...(await countCandidates(ctx.env.DB, input.orgId, fromId)), toIdentityId: toId };
}

/** Starts the operation (queued, run by a job). The route owns authority, step-up and the idempotency key. */
export async function startIdentityMove(
  ctx: ServiceContext,
  by: { userId: string },
  input: MoveInput,
): Promise<OperationDto> {
  const { fromId, toId } = await checked(ctx, input);
  const db = ctx.env.DB;
  const id = input.id ?? ctx.ids.id();
  const params = { op_id: id, org_id: input.orgId, from_identity_id: fromId, to_identity_id: toId };
  const fresh = await insertParams(db, params, ctx.clock.now());
  let op: OperationDto;
  try {
    op = await startOperation(ctx, {
      id,
      kind: 'identity.move',
      target: { type: 'org', id: input.orgId },
      actor: { type: 'user', id: by.userId },
      subject: { orgId: input.orgId },
    });
  } catch (error) {
    await dropOrphanParams(db, id);
    throw error;
  }
  if (fresh)
    await recordAudit(ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: by.userId,
      action: 'identity.move_started',
      targetType: 'operation',
      targetId: id,
      detail: { from: fromId, to: toId },
    });
  if (op.status === 'queued') await sendOperationRun(ctx, id, op.attempt);
  return op;
}
