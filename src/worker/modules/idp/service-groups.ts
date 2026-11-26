import type { CreateGroup, Group, GroupResult } from '../../../shared/contracts/idp-access.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { idpClient } from './client.ts';
import { toGroup } from './dto-groups.ts';
import { liveSourceCounts } from './repo-group-counts.ts';
import { liveMembersOfGroup } from './repo-group-members.ts';
import { liveRulesOfGroup } from './repo-group-rules.ts';
import {
  groupByKey,
  insertGroupStmt,
  liveGroupCount,
  markGroupDeleted,
  renameGroup,
} from './repo-groups.ts';
import { requireLiveGroup, ruleStatements, writeBatch } from './service-group-rules.ts';
import { type Actor, WRITABLE_ROLES, type WritableRole, type WriteCtx } from './types.ts';

/** Custom plus adopted groups. The binding holds its own configured limit; this one answers before a call. */
export const CUSTOM_GROUP_LIMIT = 50;

const isRole = (key: string): key is WritableRole =>
  (WRITABLE_ROLES as readonly string[]).includes(key);

const writeCtx = (ctx: ServiceContext, actor: Actor, reason: string): WriteCtx => ({
  ref: `group-${ctx.requestId ?? ctx.ids.id()}`,
  reason,
  actor,
});

const userActor = (id: string): Actor => ({ kind: 'user', id });

const audit = (
  ctx: ServiceContext,
  actorId: string,
  action: string,
  key: string,
  detail: Record<string, unknown>,
) =>
  auditStmt(ctx.env.DB, ctx, {
    actorType: 'user',
    actorId,
    action,
    targetType: 'idp_group',
    targetId: key,
    detail,
  });

/** A taken name answers 409 with its own words, not the binding's "changed, try again". */
const nameTaken = (error: unknown): never => {
  if (error instanceof AppError && error.code === 'IDP_CONFLICT')
    throw new ConflictError(
      'A group with this name exists in Polaris ID. Pick another key.',
      'IDP_CONFLICT',
    );
  throw error;
};

/** Polaris ID still shows members or apps that PassBook does not track. */
const inUse = (error: unknown): never => {
  if (error instanceof AppError && error.code === 'IDP_IN_USE')
    throw new ConflictError('Used by other apps in Polaris ID.', 'IDP_IN_USE');
  throw error;
};

export async function listGroups(ctx: ServiceContext): Promise<Group[]> {
  const [groups, counts] = await Promise.all([
    idpClient(ctx.env, ctx.log).groups(),
    liveSourceCounts(ctx.env.DB),
  ]);
  return groups.map((g) => toGroup(g, counts.get(g.key)));
}

export async function createGroup(
  ctx: ServiceContext,
  actorId: string,
  input: CreateGroup,
): Promise<GroupResult> {
  const db = ctx.env.DB;
  if (await groupByKey(db, input.key))
    throw new ConflictError('A group with this key exists. A key is never reused.', 'IDP_CONFLICT');
  if ((await liveGroupCount(db)) >= CUSTOM_GROUP_LIMIT)
    throw new ConflictError(
      `PassBook manages at most ${CUSTOM_GROUP_LIMIT} custom groups.`,
      'IDP_GROUP_LIMIT',
    );
  const rules = await ruleStatements(ctx, actorId, input.key, input.rules ?? []);
  const sent = await idpClient(ctx.env, ctx.log)
    .createGroup(input.key, input.friendlyName, writeCtx(ctx, userActor(actorId), 'group_create'))
    .catch(nameTaken);
  if ('dryRun' in sent) return { key: input.key, dryRun: true };
  await writeBatch(db, [
    insertGroupStmt(db, {
      key: input.key,
      kind: 'custom',
      friendlyName: input.friendlyName,
      createdBy: actorId,
      now: ctx.clock.now(),
    }),
    ...rules,
    audit(ctx, actorId, 'idp.group_create', input.key, {
      kind: 'custom',
      rules: input.rules?.length ?? 0,
    }),
  ]);
  ctx.log.info('idp.group_create', { key: input.key });
  return { key: input.key, dryRun: false };
}

/** Creates a configured role group (for example `passbook_support`) that has no id yet. */
export async function ensureRoleGroup(
  ctx: ServiceContext,
  actorId: string,
  role: WritableRole,
): Promise<GroupResult> {
  const sent = await idpClient(ctx.env, ctx.log)
    .ensureRoleGroup(role, writeCtx(ctx, userActor(actorId), 'group_ensure'))
    .catch(nameTaken);
  if ('dryRun' in sent) return { key: role, dryRun: true };
  await audit(ctx, actorId, 'idp.group_create', role, { kind: 'role' }).run();
  ctx.log.info('idp.group_create', { key: role });
  return { key: role, dryRun: false };
}

/** The display name only: the group's name never changes. */
export async function updateGroup(
  ctx: ServiceContext,
  actorId: string,
  key: string,
  friendlyName: string,
): Promise<GroupResult> {
  const db = ctx.env.DB;
  if (!isRole(key)) await requireLiveGroup(db, key);
  const sent = await idpClient(ctx.env, ctx.log).updateGroup(
    isRole(key) ? key : `g:${key}`,
    { friendlyName },
    writeCtx(ctx, userActor(actorId), 'group_update'),
  );
  if ('dryRun' in sent) return { key, dryRun: true };
  if (!isRole(key)) await renameGroup(db, key, friendlyName);
  await audit(ctx, actorId, 'idp.group_update', key, { friendlyName }).run();
  ctx.log.info('idp.group_update', { key });
  return { key, dryRun: false };
}

/** Only a custom group PassBook made, with no sources left and nothing wired to it. */
export async function deleteGroup(
  ctx: ServiceContext,
  actorId: string,
  key: string,
): Promise<GroupResult> {
  const db = ctx.env.DB;
  if (isRole(key)) throw new ConflictError("A role group can't be deleted.", 'IDP_REFUSED');
  const group = await groupByKey(db, key);
  if (!group || group.deleted_at !== null)
    throw new NotFoundError('Group not found.', 'GROUP_NOT_FOUND');
  if (group.kind !== 'custom')
    throw new ConflictError("An adopted group can't be deleted.", 'IDP_REFUSED');
  if ((await liveMembersOfGroup(db, key)).length > 0)
    throw new ConflictError('Has members. Remove them first.', 'IDP_IN_USE');
  if ((await liveRulesOfGroup(db, key)).length > 0)
    throw new ConflictError('Has org rules. End them first.', 'IDP_IN_USE');
  const sent = await idpClient(ctx.env, ctx.log)
    .deleteGroup(key, writeCtx(ctx, userActor(actorId), 'group_delete'))
    .catch(inUse);
  if ('dryRun' in sent) return { key, dryRun: true };
  await markGroupDeleted(db, key, ctx.clock.now());
  await audit(ctx, actorId, 'idp.group_delete', key, {}).run();
  ctx.log.info('idp.group_delete', { key });
  return { key, dryRun: false };
}
