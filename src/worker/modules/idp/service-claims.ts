import type {
  ClaimsResult,
  ClaimsView,
  UpdateClaims,
} from '../../../shared/contracts/idp-access.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { requireUser } from '../users/service.ts';
import { idpClient } from './client.ts';
import { subjectsOfUser } from './repo-sources.ts';
import {
  type ClaimChange,
  type ClaimOwner,
  type Target,
  WRITABLE_ROLES,
  type WriteCtx,
} from './types.ts';

/** The binding names a role by its name and a custom or adopted group as `g:<key>`. */
const targetOf = (key: string): Target =>
  (WRITABLE_ROLES as readonly string[]).includes(key) ? (key as Target) : `g:${key}`;

/** One Polaris ID account per user: with none or several, a claim has no single owner. */
async function ownerOfUser(ctx: ServiceContext, userId: string): Promise<ClaimOwner> {
  await requireUser(ctx, userId);
  const subjects = await subjectsOfUser(ctx.env.DB, userId);
  const [subject] = subjects;
  if (!subject || subjects.length > 1)
    throw new ConflictError(
      subject ? 'This user has several Polaris ID accounts.' : "This user isn't in Polaris ID.",
      subject ? 'IDP_MULTIPLE_ACCOUNTS' : 'IDP_NO_ACCOUNT',
    );
  return { subject };
}

const writeCtx = (ctx: ServiceContext, actorId: string): WriteCtx => ({
  ref: `claims-${ctx.requestId ?? ctx.ids.id()}`,
  reason: 'claims_set',
  actor: { kind: 'user', id: actorId },
});

/** Values stay out of the audit row and the log: key names only. */
async function writeClaims(
  ctx: ServiceContext,
  actorId: string,
  owner: ClaimOwner,
  target: { type: string; id: string },
  update: UpdateClaims,
): Promise<ClaimsResult> {
  const changes: Record<string, ClaimChange> = update.set;
  const result = await idpClient(ctx.env, ctx.log).setClaims(
    owner,
    changes,
    writeCtx(ctx, actorId),
  );
  if (!result.dryRun) {
    await recordAudit(ctx, {
      actorType: 'user',
      actorId,
      action: 'idp.claims_set',
      targetType: target.type,
      targetId: target.id,
      detail: { set: result.set, removed: result.removed },
    });
    ctx.log.info('idp.claims_set', {
      target: target.type,
      set: result.set.length,
      removed: result.removed.length,
    });
  }
  return result;
}

export async function userClaims(ctx: ServiceContext, userId: string): Promise<ClaimsView> {
  return idpClient(ctx.env, ctx.log).claims(await ownerOfUser(ctx, userId));
}

export async function updateUserClaims(
  ctx: ServiceContext,
  actorId: string,
  userId: string,
  update: UpdateClaims,
): Promise<ClaimsResult> {
  const owner = await ownerOfUser(ctx, userId);
  return writeClaims(ctx, actorId, owner, { type: 'user', id: userId }, update);
}

export const groupClaims = (ctx: ServiceContext, key: string): Promise<ClaimsView> =>
  idpClient(ctx.env, ctx.log).claims({ group: targetOf(key) });

export const updateGroupClaims = (
  ctx: ServiceContext,
  actorId: string,
  key: string,
  update: UpdateClaims,
): Promise<ClaimsResult> =>
  writeClaims(ctx, actorId, { group: targetOf(key) }, { type: 'idp_group', id: key }, update);
