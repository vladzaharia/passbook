import type { BroadcastDto } from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  MessageRuleBody,
  MessageRuleDto,
  UpdateMessageRuleBody,
} from '../../../shared/contracts/message-rules.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { insertAuthorizedBroadcastStmt } from '../broadcasts/repo.ts';
import { getBroadcastDto, listBroadcastDtos } from '../broadcasts/service.ts';
import { launchBroadcast } from '../broadcasts/start.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { Actor } from '../passes/service.ts';
import { anchorOf, offsetOf, toRuleDto } from './dto.ts';
import * as repo from './repo.ts';
import { checkRuleTemplates } from './validate.ts';
import { firstCheckAt } from './windows.ts';

type Body = MessageRuleBody | Omit<UpdateMessageRuleBody, 'version'>;

function valuesOf(body: Body, now: number): repo.RuleValues {
  return {
    name: body.name,
    state: body.on ? 'on' : 'paused',
    pausedCode: null,
    templateIds: body.templateIds,
    match: body.match,
    anchorKind: body.anchor.kind === 'input' ? 'input' : 'last_scan',
    anchorInput: body.anchor.kind === 'input' ? body.anchor.input : null,
    offsetAmount: body.offset.amount,
    offsetUnit: body.offset.unit,
    offsetWhen: body.offset.when,
    yearly: body.yearly,
    sendAt: body.sendAt,
    timeZone: body.timeZone,
    message: body.message,
    clearAfter: body.clearAfter ?? null,
    nextCheckAt: body.on ? firstCheckAt(body, now) : null,
  };
}

const capReached = () =>
  new ConflictError(
    `Turn one off first: ${repo.MAX_ACTIVE_RULES} automatic messages are on.`,
    'RULE_LIMIT',
  );

export async function createRule(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  body: MessageRuleBody,
  authority: TenantPassWrite,
): Promise<MessageRuleDto> {
  if (!(await orgIsActive(ctx.env.DB, body.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  await checkRuleTemplates(ctx, body.orgId, body.templateIds, body.anchor, body.offset);
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const [inserted] = await batch(ctx.env.DB, [
    repo.insertRuleStmt(
      ctx.env.DB,
      {
        id,
        orgId: body.orgId,
        mode,
        actor: { type: actor.type, id: actor.id },
        now,
        values: valuesOf(body, now),
      },
      authority,
    ),
  ]);
  if ((inserted?.meta.changes ?? 0) !== 1) {
    if (body.on && (await atCap(ctx, body.orgId, mode))) throw capReached();
    throw new ForbiddenError();
  }
  await recordAudit(ctx, {
    orgId: body.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'message_rule.create',
    targetType: 'message_rule',
    targetId: id,
    detail: { mode },
  });
  return getRuleDto(ctx, id, body.orgId);
}

async function atCap(ctx: ServiceContext, orgId: string, mode: Mode): Promise<boolean> {
  const { rows } = await repo.listRules(ctx.env.DB, {
    orgId,
    mode,
    state: 'on',
    limit: repo.MAX_ACTIVE_RULES,
  });
  return rows.length >= repo.MAX_ACTIVE_RULES;
}

export async function requireRule(ctx: ServiceContext, id: string, orgId: string | null) {
  const row = await repo.getRule(ctx.env.DB, id, orgId);
  if (!row) throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  return row;
}

export async function getRuleDto(
  ctx: ServiceContext,
  id: string,
  orgId: string | null,
): Promise<MessageRuleDto> {
  return toRuleDto(await requireRule(ctx, id, orgId));
}

export async function listRuleDtos(
  ctx: ServiceContext,
  filter: Parameters<typeof repo.listRules>[1],
): Promise<{ items: MessageRuleDto[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await repo.listRules(ctx.env.DB, filter);
  return { items: rows.map(toRuleDto), nextCursor };
}

/** Saving resumes a paused rule: the saver becomes the identity the runner re-checks. */
export async function updateRule(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  body: UpdateMessageRuleBody,
  authority: TenantPassWrite,
): Promise<MessageRuleDto> {
  const row = await requireRule(ctx, id, authority.orgId);
  if (row.mode !== authority.mode)
    throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  await checkRuleTemplates(ctx, row.org_id, body.templateIds, body.anchor, body.offset);
  const now = ctx.clock.now();
  const [updated] = await batch(ctx.env.DB, [
    repo.updateRuleStmt(
      ctx.env.DB,
      id,
      body.version,
      valuesOf(body, now),
      { type: actor.type, id: actor.id },
      authority,
      now,
    ),
  ]);
  if ((updated?.meta.changes ?? 0) !== 1) {
    const current = await requireRule(ctx, id, authority.orgId);
    if (current.version !== body.version)
      throw new ConflictError('Someone else changed this. Reload and try again.', 'RULE_VERSION');
    if (body.on && (await atCap(ctx, row.org_id, row.mode))) throw capReached();
    throw new ForbiddenError();
  }
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'message_rule.update',
    targetType: 'message_rule',
    targetId: id,
  });
  return getRuleDto(ctx, id, row.org_id);
}

export async function pauseRule(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  authority: TenantPassWrite,
): Promise<MessageRuleDto> {
  const row = await requireRule(ctx, id, authority.orgId);
  if (row.mode !== authority.mode)
    throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  const [paused] = await batch(ctx.env.DB, [
    repo.pauseRuleStmt(ctx.env.DB, id, authority, ctx.clock.now()),
  ]);
  if ((paused?.meta.changes ?? 0) !== 1 && row.state === 'on') throw new ForbiddenError();
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'message_rule.pause',
    targetType: 'message_rule',
    targetId: id,
  });
  return getRuleDto(ctx, id, row.org_id);
}

/** Deleting cancels the runs that have not started; one that is sending finishes. */
export async function deleteRule(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  authority: TenantPassWrite,
): Promise<void> {
  const row = await requireRule(ctx, id, authority.orgId);
  if (row.mode !== authority.mode)
    throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  const now = ctx.clock.now();
  const [deleted] = await batch(ctx.env.DB, [repo.deleteRuleStmt(ctx.env.DB, id, authority, now)]);
  if ((deleted?.meta.changes ?? 0) !== 1) throw new ForbiddenError();
  await repo.cancelScheduledRuns(ctx.env.DB, id, row.org_id, now);
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'message_rule.delete',
    targetType: 'message_rule',
    targetId: id,
  });
}

/** The runs a rule made, newest first. */
export async function listRuns(
  ctx: ServiceContext,
  rule: { id: string; org_id: string; mode: Mode },
  query: { cursor?: string | undefined; limit: number },
): Promise<{ items: BroadcastDto[]; nextCursor: string | null }> {
  return listBroadcastDtos(ctx, {
    orgId: rule.org_id,
    mode: rule.mode,
    origin: 'rule',
    ruleId: rule.id,
    ...query,
  });
}

/**
 * Sends the rule's text now to one of its own passes, as a one-pass run that notifies and counts
 * toward the pass's limit. It writes no fire row, so the rule still sends on its day.
 */
export async function testRule(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  passId: string,
  authority: TenantPassWrite,
): Promise<BroadcastDto> {
  const row = await requireRule(ctx, id, authority.orgId);
  if (row.mode !== authority.mode)
    throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  const pass = await getPass(ctx.env.DB, passId, row.org_id);
  const templateIds = JSON.parse(row.template_ids) as string[];
  if (!pass || pass.mode !== row.mode || !templateIds.includes(pass.templateId))
    throw new NotFoundError('Pass not found for this automatic message.', 'PASS_NOT_FOUND');
  await checkRuleTemplates(ctx, row.org_id, templateIds, anchorOf(row), offsetOf(row));
  const now = ctx.clock.now();
  const broadcastId = ctx.ids.id();
  const [inserted] = await batch(ctx.env.DB, [
    insertAuthorizedBroadcastStmt(
      ctx.env.DB,
      {
        id: broadcastId,
        orgId: row.org_id,
        mode: row.mode,
        kind: 'message',
        name: `Test: ${row.name}`.slice(0, 80),
        state: 'scheduled',
        target: { templateIds, passIds: [passId] },
        patch: { message: row.message },
        notify: true,
        at: now,
        clearAfter: row.clear_after,
        ruleId: row.id,
        windowKey: `test:${broadcastId}`,
        actor: { type: actor.type, id: actor.id },
        now,
      },
      authority,
      now,
    ),
  ]);
  if ((inserted?.meta.changes ?? 0) !== 1) throw new ForbiddenError();
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'message_rule.test',
    targetType: 'message_rule',
    targetId: id,
  });
  await launchBroadcast(ctx, { id: broadcastId, org_id: row.org_id });
  return getBroadcastDto(ctx, broadcastId, row.org_id);
}
