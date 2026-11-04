import {
  BulkPassActionResponseSchema,
  BulkPassActionSchema,
  BulkReissueResponseSchema,
  BulkReissueSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { startBulkReissue } from './bulk.ts';
import { bulkPassAction } from './bulk-actions.ts';
import { actorFor, assertOrg, orgScopeOf, svc } from './http.ts';

/** Many-pass actions: void, email or remove a selection, and template-wide reissues. */
export function registerBulkRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  passesRoutes.use('/bulk-reissue', requireAdmin);

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk',
      summary: 'Void, email or remove up to 100 passes of one org',
      body: BulkPassActionSchema,
      response: BulkPassActionResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      if (body.orgId) assertOrg(c, body.orgId);
      return c.json(await bulkPassAction(svc(c), actorFor(c), body, orgScopeOf(c)));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk-reissue',
      summary: 'Rebuild all passes of a template (admin)',
      body: BulkReissueSchema,
      status: 202,
      response: BulkReissueResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const workflowInstanceId = await startBulkReissue(svc(c), actorFor(c), body);
      return c.json({ workflowInstanceId }, 202);
    },
  );
}
