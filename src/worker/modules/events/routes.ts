import {
  IdParamSchema,
  PassDevicesSchema,
  PassEventListQuerySchema,
  PassEventListSchema,
} from '../../../shared/contracts/index.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { authOf, type C, passScopeOf, svc, tenantAuthorityOf } from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { PassScope } from '../passes/scope.ts';
import { listPassDevices } from './devices.ts';
import { listPassEvents } from './service.ts';

/** Authorize the actual pass organization and pin subsequent reads to that organization. */
async function authorizePassRead(c: C, id: string): Promise<PassScope> {
  const ctx = svc(c);
  const scope = passScopeOf(c);
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  try {
    await tenantAuthorityOf(ctx, authOf(c), pass.orgId, 'passes:read');
  } catch (error) {
    if (error instanceof ForbiddenError)
      throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    throw error;
  }
  return { ...scope, orgId: pass.orgId };
}

/** Mounted on the passes router, which already requires passes:read for GET. */
export function registerEventRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/events',
      summary: 'Sync log and activity of a pass, newest first',
      params: IdParamSchema,
      query: PassEventListQuerySchema,
      response: PassEventListSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const scope = await authorizePassRead(c, id);
      return c.json(await listPassEvents(svc(c), id, scope, c.req.valid('query')));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/devices',
      summary: 'Devices of a pass with their sync status',
      params: IdParamSchema,
      response: PassDevicesSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const scope = await authorizePassRead(c, id);
      return c.json(await listPassDevices(svc(c), id, scope));
    },
  );
}
