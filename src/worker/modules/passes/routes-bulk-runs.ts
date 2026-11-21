import { z } from 'zod';
import { BulkRunSchema, StartBulkRunSchema } from '../../../shared/contracts/pass-bulk-runs.ts';
import { ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { getBulkRun, startBulkRun, stopBulkRun } from './bulk-run.ts';
import { actorFor, assertOrg, authOf, passScopeOf, svc, tenantAuthorityOf } from './http.ts';
import { requireTenantPassRead } from './pass-access.ts';

const RunParams = z.object({ id: z.string().min(1).max(64) });
const OrgQuery = z.object({ orgId: z.string().min(1).max(64).optional() });

/** Background bulk actions over every pass a filter matches. */
export function registerBulkRunRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  const orgOf = (c: Parameters<typeof assertOrg>[0], given: string | undefined): string => {
    const auth = authOf(c);
    const orgId = given ?? (auth.kind === 'api_key' ? (auth.orgId ?? undefined) : undefined);
    if (!orgId)
      throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
    assertOrg(c, orgId);
    return orgId;
  };

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk-runs',
      summary: 'Void, email or remove every pass a filter matches, in the background',
      body: StartBulkRunSchema,
      status: 202,
      response: BulkRunSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const ctx = svc(c);
      const orgId = orgOf(c, body.orgId);
      const authority = await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const run = await startBulkRun(ctx, actorFor(c), {
        authority,
        mode: passScopeOf(c).mode,
        action: body.action,
        message: body.message,
        filter: body.selection.filter,
        expectCount: body.selection.expectCount,
      });
      return c.json(run, 202);
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/bulk-runs/{id}',
      summary: 'Get the progress of a bulk run',
      params: RunParams,
      query: OrgQuery,
      response: BulkRunSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const orgId = orgOf(c, c.req.valid('query').orgId);
      await requireTenantPassRead(ctx, authOf(c), orgId);
      return c.json(await getBulkRun(ctx, c.req.valid('param').id, orgId, passScopeOf(c).mode));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk-runs/{id}/stop',
      summary: 'Stop a bulk run after its current chunk',
      params: RunParams,
      query: OrgQuery,
      response: BulkRunSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const orgId = orgOf(c, c.req.valid('query').orgId);
      await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      return c.json(await stopBulkRun(ctx, c.req.valid('param').id, orgId, passScopeOf(c).mode));
    },
  );
}
