import type { OpenAPIHono } from '@hono/zod-openapi';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  ScanConsoleMarkOutSchema,
  ScanWhosInListSchema,
  ScanWhosInQuerySchema,
} from '../../../shared/contracts/scan-whos-in.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, tenantAuthorityOf } from '../passes/http.ts';
import { type ConsoleTarget, consoleInside, consoleMarkOut } from './occupancy/console-inside.ts';
import { getConsoleEventTarget } from './repo-events.ts';
import { zoneTarget } from './repo-zones.ts';

/** The org of a zone or an event, or a 404 for anyone who is not in it (and for an event of the other mode). */
async function authorize(c: C, t: ConsoleTarget, capability: 'scanning:read' | 'scanning:manage') {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const found =
    t.kind === 'zone'
      ? await zoneTarget(ctx.env.DB, t.id)
      : await getConsoleEventTarget(ctx.env.DB, t.id);
  const missing = () =>
    new NotFoundError(
      t.kind === 'zone' ? 'Zone not found.' : 'Event not found.',
      t.kind === 'zone' ? 'ZONE_NOT_FOUND' : 'EVENT_NOT_FOUND',
    );
  if (!found || !(await getOrgAccess(ctx, auth.userId, found.orgId))) throw missing();
  if ('mode' in found && found.mode !== modeOf(auth)) throw missing();
  const authority = await tenantAuthorityOf(ctx, auth, found.orgId, capability);
  if (authority.kind !== 'session') throw new UnauthenticatedError();
  return { ctx, orgId: found.orgId, mode: modeOf(auth), authority };
}

/** `GET /{id}/inside` and `POST /{id}/mark-out` on the console zones and events routers. */
export function registerConsoleInsideRoutes(
  router: OpenAPIHono<AppBindings>,
  tag: string,
  kind: ConsoleTarget['kind'],
): void {
  register(
    router,
    tag,
    {
      method: 'get',
      path: '/{id}/inside',
      summary: "Who's inside",
      params: IdParamSchema,
      query: ScanWhosInQuerySchema,
      response: ScanWhosInListSchema,
    },
    async (c) => {
      const t = { kind, id: c.req.valid('param').id };
      const { ctx, orgId, mode } = await authorize(c, t, 'scanning:read');
      return c.json(await consoleInside(ctx, orgId, mode, t, c.req.valid('query')));
    },
  );
  register(
    router,
    tag,
    {
      method: 'post',
      path: '/{id}/mark-out',
      summary: 'Mark someone as out',
      params: IdParamSchema,
      body: ScanConsoleMarkOutSchema,
      status: 204,
    },
    async (c) => {
      const t = { kind, id: c.req.valid('param').id };
      const { ctx, authority } = await authorize(c, t, 'scanning:manage');
      await consoleMarkOut(ctx, currentUserId(c), authority, t, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
}
