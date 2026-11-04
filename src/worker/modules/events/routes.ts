import {
  IdParamSchema,
  PassEventListQuerySchema,
  PassEventListSchema,
} from '../../../shared/contracts/index.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { orgScopeOf, svc } from '../passes/http.ts';
import { listPassEvents } from './service.ts';

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
    async (c) =>
      c.json(
        await listPassEvents(svc(c), c.req.valid('param').id, orgScopeOf(c), c.req.valid('query')),
      ),
  );
}
