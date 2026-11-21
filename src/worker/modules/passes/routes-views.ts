import {
  PassViewListSchema,
  PassViewsQuerySchema,
  PutPassViewsSchema,
} from '../../../shared/contracts/pass-views.ts';
import { ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { assertOrg, authOf, svc, tenantAuthorityOf } from './http.ts';
import { requireTenantPassRead } from './pass-access.ts';
import { readPassViews, writePassViews } from './repo-views.ts';

/** Saved views of the passes list, kept per organization. Register before `/{id}`. */
export function registerViewRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
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
      method: 'get',
      path: '/views',
      summary: 'List the saved views of the passes list',
      query: PassViewsQuerySchema,
      response: PassViewListSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const orgId = orgOf(c, c.req.valid('query').orgId);
      await requireTenantPassRead(ctx, authOf(c), orgId);
      return c.json({ items: await readPassViews(ctx.env.DB, orgId) });
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'put',
      path: '/views',
      summary: 'Replace the saved views of the passes list',
      body: PutPassViewsSchema,
      response: PassViewListSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const ctx = svc(c);
      const orgId = orgOf(c, body.orgId);
      await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      await writePassViews(ctx.env.DB, orgId, body.items, ctx.clock.now());
      return c.json({ items: body.items });
    },
  );
}
