import { z } from 'zod';
import {
  BroadcastListQuerySchema,
  BroadcastListSchema,
  IdParamSchema,
  MessageRuleBodySchema,
  MessageRuleListQuerySchema,
  MessageRuleListSchema,
  MessageRuleSchema,
  UpdateMessageRuleSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  requireTenantSessionOrApiKey,
  svc,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import {
  createRule,
  deleteRule,
  getRuleDto,
  listRuleDtos,
  listRuns,
  pauseRule,
  requireRule,
  updateRule,
} from './service.ts';

type Ctx = Parameters<typeof authOf>[0];

/** Bind by-id access to the stored org; a session outside the org sees a missing rule. */
async function authorityOf(
  c: Ctx,
  id: string,
  capability: 'messages:read' | 'messages:manage',
): Promise<{ authority: TenantPassWrite; row: Awaited<ReturnType<typeof requireRule>> }> {
  const ctx = svc(c);
  const auth = authOf(c);
  const row = await requireRule(ctx, id, null);
  if (auth.kind === 'api_key' && row.mode !== modeOf(auth))
    throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
  try {
    return { authority: await tenantAuthorityOf(ctx, auth, row.org_id, capability), row };
  } catch (error) {
    if (
      error instanceof ForbiddenError &&
      auth.kind === 'session' &&
      !(await activeMembership(ctx.env.DB, auth.userId, row.org_id))
    )
      throw new NotFoundError('Automatic message not found.', 'RULE_NOT_FOUND');
    throw error;
  }
}

/** /api/v1/message-rules: messages sent automatically, by date or by time since a scan. */
export const messageRulesRoutes = createRouter();
guard(messageRulesRoutes, requireTenantSessionOrApiKey('messages:write'));

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'get',
    path: '/',
    summary: 'List automatic messages',
    query: MessageRuleListQuerySchema,
    response: MessageRuleListSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const q = c.req.valid('query');
    const orgId = q.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
    if (!orgId)
      throw new ValidationError('Choose an organization.', [
        { path: 'orgId', message: 'Choose an organization.' },
      ]);
    assertOrg(c, orgId);
    await tenantAuthorityOf(ctx, auth, orgId, 'messages:read');
    return c.json(
      await listRuleDtos(ctx, {
        orgId,
        mode: modeOf(auth),
        state: q.state,
        cursor: q.cursor,
        limit: q.limit,
      }),
    );
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'post',
    path: '/',
    summary: 'Create an automatic message',
    body: MessageRuleBodySchema,
    status: 201,
    response: MessageRuleSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    const authority = await tenantAuthorityOf(ctx, auth, body.orgId, 'messages:manage');
    return c.json(await createRule(ctx, actorFor(c), modeOf(auth), body, authority), 201);
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'get',
    path: '/{id}',
    summary: 'One automatic message',
    params: IdParamSchema,
    response: MessageRuleSchema,
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const { row } = await authorityOf(c, id, 'messages:read');
    return c.json(await getRuleDto(svc(c), id, row.org_id));
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'put',
    path: '/{id}',
    summary: 'Save an automatic message; saving resumes a paused one',
    params: IdParamSchema,
    body: UpdateMessageRuleSchema,
    response: MessageRuleSchema,
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const { authority, row } = await authorityOf(c, id, 'messages:manage');
    if (body.orgId !== row.org_id)
      throw new ValidationError('That message belongs to another organization.', [
        { path: 'orgId', message: 'Wrong organization.' },
      ]);
    return c.json(await updateRule(svc(c), actorFor(c), id, body, authority));
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'post',
    path: '/{id}/pause',
    summary: 'Pause an automatic message',
    params: IdParamSchema,
    response: MessageRuleSchema,
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const { authority } = await authorityOf(c, id, 'messages:manage');
    return c.json(await pauseRule(svc(c), actorFor(c), id, authority));
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an automatic message and cancel its runs that have not started',
    params: IdParamSchema,
    response: z.object({ ok: z.literal(true) }),
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const { authority } = await authorityOf(c, id, 'messages:manage');
    await deleteRule(svc(c), actorFor(c), id, authority);
    return c.json({ ok: true as const });
  },
);

register(
  messageRulesRoutes,
  'message-rules',
  {
    method: 'get',
    path: '/{id}/runs',
    summary: 'The messages an automatic message sent',
    params: IdParamSchema,
    query: BroadcastListQuerySchema.pick({ cursor: true, limit: true }),
    response: BroadcastListSchema,
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const { row } = await authorityOf(c, id, 'messages:read');
    return c.json(await listRuns(svc(c), row, c.req.valid('query')));
  },
);
