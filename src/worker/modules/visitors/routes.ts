import { z } from 'zod';
import {
  OffboardRequestSchema,
  OffboardResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { CursorQuerySchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  HostListSchema,
  NewVisitorSchema,
  VisitorListSchema,
  VisitorOrgQuerySchema,
  VisitorParamsSchema,
  VisitorQuerySchema,
  VisitorSchema,
} from '../../../shared/contracts/visitors.ts';
import { methodScope } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  actorFor,
  authOf,
  orgIdOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { resendHostNotice } from './arrival.ts';
import { offboard } from './offboard.ts';
import { hostChoices, visitorById } from './repo.ts';
import { cancelVisit, canTypeHost, checkOutVisit, createVisit, listVisits } from './service.ts';

/**
 * /api/v1/visitors: visits and their hosts. A console session or an API key (`passes:read` to read,
 * `passes:write` to change). The org is named in the request, as for tags.
 */
export const visitorsRoutes = createRouter();
guard(
  visitorsRoutes,
  requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'passes:write' })),
);
visitorsRoutes.use('*', limitBody(8 * 1024));

const TAG = 'visitors';

/** Offboarding by email or external ID: /api/v1/offboard, same scopes. */
export const offboardRoutes = createRouter();
guard(offboardRoutes, requireTenantSessionOrApiKey(['passes:write']));
offboardRoutes.use('*', limitBody(8 * 1024));

register(
  visitorsRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'List visitors for a day',
    query: VisitorQuerySchema.extend(CursorQuerySchema.shape),
    response: VisitorListSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    const ctx = svc(c);
    const a = await tenantAuthorityOf(ctx, authOf(c), orgIdOf(authOf(c), q.orgId), 'passes:read');
    return c.json({
      items: await listVisits(ctx, a.orgId, a.mode, q.tab, { start: q.dayStart, end: q.dayEnd }),
      nextCursor: null,
    });
  },
);

register(
  visitorsRoutes,
  TAG,
  {
    method: 'get',
    path: '/hosts',
    summary: 'People who can host a visitor: the org members',
    query: VisitorOrgQuerySchema.extend(CursorQuerySchema.shape),
    response: HostListSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const a = await tenantAuthorityOf(
      ctx,
      auth,
      orgIdOf(auth, c.req.valid('query').orgId),
      'passes:read',
    );
    const emails = await canTypeHost(ctx, a);
    const items = await hostChoices(ctx.env.DB, a.orgId);
    return c.json({
      items: items.map((h) => ({ ...h, email: emails ? h.email : null })),
      nextCursor: null,
    });
  },
);

register(
  visitorsRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Invite a visitor: a visitor pass with a host',
    body: NewVisitorSchema,
    status: 201,
    response: VisitorSchema,
  },
  async (c) => {
    const body = c.req.valid('json');
    const ctx = svc(c);
    const a = await tenantAuthorityOf(ctx, authOf(c), body.orgId, 'passes:operate');
    return c.json(await createVisit(ctx, actorFor(c), a, body), 201);
  },
);

for (const [path, summary, run] of [
  [
    '/{id}/check-out',
    'Check a visitor out',
    (c: Parameters<typeof svc>[0], id: string, orgId: string | undefined) =>
      tenantAuthorityOf(svc(c), authOf(c), orgIdOf(authOf(c), orgId), 'passes:operate').then((a) =>
        checkOutVisit(svc(c), a, id),
      ),
  ],
  [
    '/{id}/cancel',
    'Cancel a visit and void its pass',
    (c: Parameters<typeof svc>[0], id: string, orgId: string | undefined) =>
      tenantAuthorityOf(svc(c), authOf(c), orgIdOf(authOf(c), orgId), 'passes:operate').then((a) =>
        cancelVisit(svc(c), actorFor(c), a, id),
      ),
  ],
] as const) {
  register(
    visitorsRoutes,
    TAG,
    {
      method: 'post',
      path,
      summary,
      params: VisitorParamsSchema,
      query: VisitorOrgQuerySchema,
      response: VisitorSchema,
    },
    async (c) => c.json(await run(c, c.req.valid('param').id, c.req.valid('query').orgId)),
  );
}

register(
  visitorsRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/host-email',
    summary: 'Send the host their arrival email again',
    params: VisitorParamsSchema,
    query: VisitorOrgQuerySchema,
    body: z.strictObject({ timeZone: z.string().min(1).max(64).default('UTC') }),
    response: OkSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const orgId = orgIdOf(auth, c.req.valid('query').orgId);
    const a = await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate');
    const row = await visitorById(ctx.env.DB, a.orgId, a.mode, c.req.valid('param').id);
    if (!row) throw new NotFoundError('Visitor not found.', 'VISITOR_NOT_FOUND');
    await resendHostNotice(ctx, row, c.req.valid('json').timeZone);
    return c.json({ ok: true as const });
  },
);

register(
  offboardRoutes,
  'offboard',
  {
    method: 'post',
    path: '/',
    summary: 'Offboard a person: void or remove their passes and let go of their tags',
    query: VisitorOrgQuerySchema,
    body: OffboardRequestSchema,
    response: OffboardResultSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const orgId = orgIdOf(auth, c.req.valid('query').orgId);
    const a = await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate');
    return c.json(await offboard(ctx, actorFor(c), a, c.req.valid('json')));
  },
);
