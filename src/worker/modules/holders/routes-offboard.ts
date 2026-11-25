import { z } from 'zod';
import {
  OffboardRequestSchema,
  OffboardResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { IdSchema } from '../../../shared/contracts/common.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  actorFor,
  authOf,
  orgIdOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { offboard } from './offboard.ts';

/** Offboarding by email or external ID: /api/v1/offboard. A console session or an API key with `passes:write`. */
export const offboardRoutes = createRouter();
guard(offboardRoutes, requireTenantSessionOrApiKey(['passes:write']));
offboardRoutes.use('*', limitBody(8 * 1024));

register(
  offboardRoutes,
  'offboard',
  {
    method: 'post',
    path: '/',
    summary: 'Offboard a person: void or remove their passes and let go of their tags',
    query: z.object({ orgId: IdSchema.optional() }),
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
