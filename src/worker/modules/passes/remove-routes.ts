import {
  IdParamSchema,
  PassActionResponseSchema,
  RemovePassSchema,
} from '../../../shared/contracts/index.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { authority, scope } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await removePass(ctx, actorFor(c), id, c.req.valid('json'), scope, authority));
    },
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { authority, scope } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await restorePass(ctx, actorFor(c), id, scope, authority));
    },
  );
}
