import { BroadcastUndoResultSchema } from '../../../shared/contracts/broadcasts-change.ts';
import { BroadcastSchema, IdParamSchema } from '../../../shared/contracts/index.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, svc } from '../passes/http.ts';
import type { BroadcastScope } from './guards.ts';
import { stopBroadcast, undoBroadcast } from './undo.ts';

type ScopeOf = (
  c: Parameters<typeof svc>[0],
  id: string,
  capability: 'messages:read' | 'messages:manage',
) => Promise<BroadcastScope>;

/** Undo and stop for change runs. */
export function registerChangeRoutes(
  router: ReturnType<typeof createRouter>,
  scopeOf: ScopeOf,
): void {
  register(
    router,
    'broadcasts',
    {
      method: 'post',
      path: '/{id}/undo',
      summary: 'Undo a change for 24 hours: restores passes still at the value the change set',
      params: IdParamSchema,
      response: BroadcastUndoResultSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const scope = await scopeOf(c, id, 'messages:manage');
      return c.json(await undoBroadcast(svc(c), actorFor(c), id, scope));
    },
  );

  register(
    router,
    'broadcasts',
    {
      method: 'post',
      path: '/{id}/stop',
      summary: 'Stop a sending message or change after its current chunk',
      params: IdParamSchema,
      response: BroadcastSchema,
    },
    async (c) => {
      const id = c.req.valid('param').id;
      const scope = await scopeOf(c, id, 'messages:manage');
      return c.json(await stopBroadcast(svc(c), actorFor(c), id, scope));
    },
  );
}
