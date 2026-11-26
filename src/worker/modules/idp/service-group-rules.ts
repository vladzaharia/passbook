import type { GroupRule, GroupRuleInput } from '../../../shared/contracts/idp-access.ts';
import type { Actor as PlatformActor } from '../../platform/actor.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { requireOrg } from '../orgs/service.ts';
import { auditActorOf, byUserOf } from './actor.ts';
import { toRule } from './dto-groups.ts';
import { endRuleStmt, insertRuleStmt, liveRulesOfGroup, ruleById } from './repo-group-rules.ts';
import { groupByKey } from './repo-groups.ts';

/** A custom or adopted group that is live. A role group has no rules, and a deleted one has none to show. */
export async function requireLiveGroup(db: D1Database, key: string) {
  const group = await groupByKey(db, key);
  if (!group || group.deleted_at !== null)
    throw new NotFoundError('Group not found.', 'GROUP_NOT_FOUND');
  return group;
}

/** Personal orgs, developer sandboxes and closed orgs never feed a group. */
export async function assertRuleOrg(ctx: ServiceContext, orgId: string): Promise<void> {
  const org = await requireOrg(ctx, orgId);
  if (
    org.personal_user_id !== null ||
    org.kind !== 'standard' ||
    !['active', 'suspended'].includes(org.status)
  )
    throw new ConflictError(
      "A personal org or sandbox can't feed a group.",
      'IDP_RULE_ORG_REFUSED',
    );
}

/** The statements for a rule, checked first so a refusal is a clear 4xx and not a trigger abort. */
export async function ruleStatements(
  ctx: ServiceContext,
  actor: PlatformActor,
  groupKey: string,
  inputs: readonly GroupRuleInput[],
): Promise<D1PreparedStatement[]> {
  const db = ctx.env.DB;
  const live = await liveRulesOfGroup(db, groupKey);
  const seen = new Set(live.map((r) => r.org_id));
  if (live.length + inputs.length > 5)
    throw new ConflictError('A group takes at most 5 org rules.', 'IDP_RULE_LIMIT');
  const out: D1PreparedStatement[] = [];
  const by = await byUserOf(db, actor);
  for (const input of inputs) {
    if (seen.has(input.orgId))
      throw new ConflictError('This org already has a rule on the group.', 'IDP_RULE_EXISTS');
    seen.add(input.orgId);
    await assertRuleOrg(ctx, input.orgId);
    const id = ctx.ids.id();
    out.push(
      insertRuleStmt(db, {
        id,
        groupKey,
        orgId: input.orgId,
        orgRoles: input.orgRoles ?? null,
        createdBy: by,
        now: ctx.clock.now(),
      }),
      auditStmt(db, ctx, {
        ...auditActorOf(actor),
        action: 'idp.group_rule',
        targetType: 'idp_group',
        targetId: groupKey,
        detail: { op: 'add', ruleId: id, orgId: input.orgId, orgRoles: input.orgRoles ?? null },
      }),
    );
  }
  return out;
}

/** D1's own refusals map to a conflict; anything else is a fault. */
export async function writeBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await batch(db, statements);
  } catch (error) {
    const info = classifyD1Error(error, { triggers: true });
    if (info?.kind === 'unique')
      throw new ConflictError('This was just added. Reload and try again.', 'IDP_CONFLICT');
    if (info?.kind === 'trigger')
      throw new ConflictError('The group or org no longer accepts this.', 'IDP_RULE_ORG_REFUSED');
    throw error;
  }
}

export async function listRules(ctx: ServiceContext, key: string): Promise<GroupRule[]> {
  const db = ctx.env.DB;
  await requireLiveGroup(db, key);
  return (await liveRulesOfGroup(db, key)).map(toRule);
}

export async function addRule(
  ctx: ServiceContext,
  actor: PlatformActor,
  key: string,
  input: GroupRuleInput,
): Promise<GroupRule> {
  const db = ctx.env.DB;
  await requireLiveGroup(db, key);
  await writeBatch(db, await ruleStatements(ctx, actor, key, [input]));
  const rule = (await liveRulesOfGroup(db, key)).find((r) => r.org_id === input.orgId);
  if (!rule)
    throw new ConflictError('This was just changed. Reload and try again.', 'IDP_CONFLICT');
  ctx.log.info('idp.group_rule', { key, op: 'add' });
  return toRule(rule);
}

export async function endRule(
  ctx: ServiceContext,
  actor: PlatformActor,
  key: string,
  ruleId: string,
): Promise<void> {
  const db = ctx.env.DB;
  const rule = await ruleById(db, ruleId);
  if (!rule || rule.group_key !== key || rule.ended_at !== null)
    throw new NotFoundError('Rule not found.', 'RULE_NOT_FOUND');
  await batch(db, [
    endRuleStmt(db, ruleId, await byUserOf(db, actor), ctx.clock.now()),
    auditStmt(db, ctx, {
      ...auditActorOf(actor),
      action: 'idp.group_rule',
      targetType: 'idp_group',
      targetId: key,
      detail: { op: 'end', ruleId, orgId: rule.org_id },
    }),
  ]);
  ctx.log.info('idp.group_rule', { key, op: 'end' });
}
