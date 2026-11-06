import { PassCheckInSchema, PutPassCheckInSchema } from '../../../shared/contracts/check-in.ts';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { getPassCheckIn, putPassCheckIn } from './check-in.ts';
import { actorFor, passScopeOf, svc } from './http.ts';

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
    async (c) => c.json(await getPassCheckIn(svc(c), c.req.valid('param').id, passScopeOf(c))),
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
    async (c) =>
      c.json(
        await putPassCheckIn(
          svc(c),
          actorFor(c),
          c.req.valid('param').id,
          c.req.valid('json').rules,
          passScopeOf(c),
        ),
      ),
  );
}
