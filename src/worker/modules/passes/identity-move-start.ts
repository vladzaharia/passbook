import { assertCanSign } from '../../../passkit/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { intermediatePem } from '../identities/env-identity.ts';
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

/**
 * Runs the checks `signPass` makes on the target's certificate, for the pass type and team it signs as, so a target
 * that cannot sign is refused before a row is planned instead of failing the first replacement. Only the
 * certificate is read, never the key. An identity with no certificate to read cannot sign either.
 */
async function assertTargetSigns(
  ctx: ServiceContext,
  target: {
    certificate?: string | null | undefined;
    passTypeIdentifier?: string | undefined;
    teamIdentifier?: string | undefined;
  },
) {
  if (!target.certificate)
    throw new NotFoundError('Signing identity is not configured.', 'IDENTITY_NOT_CONFIGURED');
  const { passTypeIdentifier, teamIdentifier } = target;
  try {
    await assertCanSign(
      { certificate: target.certificate, intermediate: intermediatePem(ctx.env) },
      {
        now: new Date(ctx.clock.now()),
        ...(passTypeIdentifier && teamIdentifier
          ? { expectedIdentity: { passTypeIdentifier, teamIdentifier } }
          : {}),
      },
    );
  } catch (error) {
    const why = (error as { code?: unknown }).code;
    if (why === 'SIGN_CERT_NOT_VALID')
      throw new ConflictError(
        'The new identity has expired. Renew it, then try again.',
        'IDENTITY_EXPIRED',
      );
    if (why === 'SIGN_INTERMEDIATE_EXPIRED')
      throw new ConflictError(
        'The Apple intermediate certificate has expired. Update it, then try again.',
        'IDENTITY_INTERMEDIATE_EXPIRED',
      );
    if (why === 'SIGN_IDENTITY_MISMATCH')
      throw new ConflictError(
        "The new identity's certificate is for another pass type or team. Upload the right one.",
        'IDENTITY_CERT_MISMATCH',
      );
    throw new ConflictError(
      'The new identity does not chain to the Apple intermediate. Check it, then try again.',
      'IDENTITY_CHAIN_INVALID',
    );
  }
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
  await assertTargetSigns(
    ctx,
    'material' in to
      ? {
          certificate: to.material.certificate,
          passTypeIdentifier: to.passTypeIdentifier,
          teamIdentifier: to.teamIdentifier,
        }
      : to,
  );
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
