import { PassCheckInSchema, PutPassCheckInSchema } from '../../../shared/contracts/check-in.ts';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { getPassCheckIn, putPassCheckIn } from './check-in.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForRead, tenantPassForWrite } from './pass-access.ts';

export function registerCheckInRoutes(router: ReturnType<typeof createRouter>) {
  register(
    router,
    'passes',
    {
      method: 'get',
      path: '/{id}/check-in',
      summary: 'Pass check-in rules',
      params: IdParamSchema,
      response: PassCheckInSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope } = await tenantPassForRead(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await getPassCheckIn(ctx, id, scope));
    },
  );
  register(
    router,
    'passes',
    {
      method: 'put',
      path: '/{id}/check-in',
      summary: 'Set pass check-in rules',
      params: IdParamSchema,
      body: PutPassCheckInSchema,
      response: PassCheckInSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { authority, scope } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(
        await putPassCheckIn(ctx, actorFor(c), id, c.req.valid('json').rules, scope, authority),
      );
    },
  );
}
