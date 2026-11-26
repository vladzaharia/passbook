import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { PassDetailSchema } from '../../../shared/contracts/passes.ts';
import { PassStampsActionSchema } from '../../../shared/contracts/stamps.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { forwardedId } from './pass-replaced.ts';
import { stampPass } from './stamps.ts';

export function registerStampsRoutes(router: ReturnType<typeof createRouter>) {
  register(
    router,
    'passes',
    {
      method: 'post',
      path: '/{id}/stamps',
      summary: 'Add stamps or redeem the reward on a stamp card',
      params: IdParamSchema,
      body: PassStampsActionSchema,
      response: PassDetailSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = await forwardedId(ctx.env.DB, c.req.valid('param').id);
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const detail = await stampPass(ctx, actorFor(c), id, c.req.valid('json'), {
        scope,
        authority,
      });
      return c.json(detail, 200, { etag: `"${detail.version}"` });
    },
  );
}
