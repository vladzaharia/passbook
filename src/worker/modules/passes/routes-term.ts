import { z } from 'zod';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { PassDetailSchema } from '../../../shared/contracts/passes.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { forwardedId } from './pass-replaced.ts';
import { renewPass } from './renew.ts';

export function registerTermRoutes(router: ReturnType<typeof createRouter>) {
  register(
    router,
    'passes',
    {
      method: 'post',
      path: '/{id}/renew',
      summary: 'Renew the term of a pass',
      params: IdParamSchema,
      body: z.object({}).optional(),
      response: PassDetailSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = await forwardedId(ctx.env.DB, c.req.valid('param').id);
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const detail = await renewPass(ctx, actorFor(c), id, { scope, authority });
      return c.json(detail, 200, { etag: `"${detail.version}"` });
    },
  );
}
