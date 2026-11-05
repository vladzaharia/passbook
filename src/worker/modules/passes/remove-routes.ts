import {
  IdParamSchema,
  PassActionResponseSchema,
  RemovePassSchema,
} from '../../../shared/contracts/index.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, passScopeOf, svc } from './http.ts';
import { removePass, restorePass } from './remove.ts';

export function registerRemoveRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/remove',
      summary: 'Remove from Wallet: publish a voided, expired final version',
      params: IdParamSchema,
      body: RemovePassSchema,
      response: PassActionResponseSchema,
    },
    async (c) =>
      c.json(
        await removePass(
          svc(c),
          actorFor(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          passScopeOf(c),
        ),
      ),
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/restore',
      summary: 'Undo a removal',
      params: IdParamSchema,
      response: PassActionResponseSchema,
    },
    async (c) =>
      c.json(await restorePass(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c))),
  );
}
