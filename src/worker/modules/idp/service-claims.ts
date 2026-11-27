import type {
  ClaimsResult,
  ClaimsView,
  UpdateClaims,
} from '../../../shared/contracts/idp-access.ts';
import type { Actor } from '../../platform/actor.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { requireUser } from '../users/service.ts';
import { auditActorOf, bindingActorOf } from './actor.ts';
import { idpClient } from './client.ts';
import { idpCodeOf } from './errors.ts';
import { isLiveAdmin } from './platform-admin.ts';
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
async function ownerOfUser(ctx: ServiceContext, actor: Actor, userId: string): Promise<ClaimOwner> {
  const user = await requireUser(ctx, userId);
  // A key never touches a platform admin's claims: that is a person's call (the offboard rule).
  if (actor.keyId && (await isLiveAdmin(ctx, userId, user.last_roles)))
    throw new ConflictError(
      'Platform admins hold every role. Change it in Polaris ID.',
      'IDP_PLATFORM_ADMIN',
    );
  const subjects = await subjectsOfUser(ctx.env.DB, userId);
  const [subject] = subjects;
  if (!subject || subjects.length > 1)
    throw new ConflictError(
      subject ? 'This user has several Polaris ID accounts.' : "This user isn't in Polaris ID.",
      subject ? 'IDP_MULTIPLE_ACCOUNTS' : 'IDP_NO_ACCOUNT',
    );
  return { subject };
}

const writeCtx = (ctx: ServiceContext, actor: Actor): WriteCtx => ({
  ref: `claims-${ctx.requestId ?? ctx.ids.id()}`,
  reason: 'claims_set',
  actor: bindingActorOf(actor),
});

type AuditTarget = { type: string; id: string };

/** Values stay out of the audit row and the log: key names only. */
async function writeClaims(
  ctx: ServiceContext,
  actor: Actor,
  owner: ClaimOwner,
  target: AuditTarget,
  update: UpdateClaims,
): Promise<ClaimsResult> {
  const changes: Record<string, ClaimChange> = update.set;
  const audit = (detail: Record<string, unknown>) =>
    recordAudit(ctx, {
      ...auditActorOf(actor),
      action: 'idp.claims_set',
      targetType: target.type,
      targetId: target.id,
      detail,
    });
  let result: ClaimsResult;
  try {
    result = await idpClient(ctx.env, ctx.log).setClaims(owner, changes, writeCtx(ctx, actor));
  } catch (error) {
    // Drift is raised only after the PUT was sent (never in dry run): keep the attempt.
    if (idpCodeOf(error) === 'IDP_DRIFT')
      await audit({ attempted: Object.keys(changes), outcome: 'IDP_DRIFT' });
    throw error;
  }
  if (!result.dryRun && (result.set.length > 0 || result.removed.length > 0)) {
    await audit({ set: result.set, removed: result.removed });
    ctx.log.info('idp.claims_set', {
      target: target.type,
      set: result.set.length,
      removed: result.removed.length,
    });
  }
  return result;
}

/** A read is attributable too: who looked at whose claims, and how many keys, never a value. */
async function readClaims(
  ctx: ServiceContext,
  actor: Actor,
  owner: ClaimOwner,
  target: AuditTarget,
): Promise<ClaimsView> {
  const view = await idpClient(ctx.env, ctx.log).claims(owner);
  await recordAudit(ctx, {
    ...auditActorOf(actor),
    action: 'idp.claims_read',
    targetType: target.type,
    targetId: target.id,
    detail: { keys: Object.keys(view.claims).length },
  });
  return view;
}

export async function userClaims(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
): Promise<ClaimsView> {
  return readClaims(ctx, actor, await ownerOfUser(ctx, actor, userId), {
    type: 'user',
    id: userId,
  });
}

export async function updateUserClaims(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  update: UpdateClaims,
): Promise<ClaimsResult> {
  const owner = await ownerOfUser(ctx, actor, userId);
  return writeClaims(ctx, actor, owner, { type: 'user', id: userId }, update);
}

export const groupClaims = (ctx: ServiceContext, actor: Actor, key: string): Promise<ClaimsView> =>
  readClaims(ctx, actor, { group: targetOf(key) }, { type: 'idp_group', id: key });

export const updateGroupClaims = (
  ctx: ServiceContext,
  actor: Actor,
  key: string,
  update: UpdateClaims,
): Promise<ClaimsResult> =>
  writeClaims(ctx, actor, { group: targetOf(key) }, { type: 'idp_group', id: key }, update);
