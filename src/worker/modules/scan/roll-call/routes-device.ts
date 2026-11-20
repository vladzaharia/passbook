import type { OpenAPIHono } from '@hono/zod-openapi';
import { IdParamSchema } from '../../../../shared/contracts/common.ts';
import {
  RollCallCurrentSchema,
  RollCallMarksRequestSchema,
  RollCallSchema,
} from '../../../../shared/contracts/scan-roll-call.ts';
import type { AppBindings } from '../../../platform/context.ts';
import { register } from '../../../platform/openapi.ts';
import { serviceContext } from '../../../platform/service-context.ts';
import { requireScanActor, scanActorOf } from '../guard.ts';
import { admitWhosIn } from '../occupancy/whos-in.ts';
import { cloneObservedScanActor } from '../scanning-workspace-observation.ts';
import { deviceCaller } from './caller.ts';
import {
  currentRollCall,
  endRollCall,
  markRollCall,
  readRollCall,
  startRollCall,
} from './service.ts';

/** A device's roll call: `/scan/roll-call`. Desk and above, as Who's in; a monitor needs Desk actions on. */
export function registerDeviceRollCallRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  const actor = requireScanActor({ capability: 'passes:operate', screenActions: true });
  for (const path of ['/roll-call', '/roll-call/*']) scanRoutes.use(path, actor);
  const caller = (c: Parameters<typeof scanActorOf>[0]) => {
    const who = cloneObservedScanActor(scanActorOf(c));
    admitWhosIn(who);
    return deviceCaller(serviceContext(c), who);
  };
  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/roll-call',
      summary: "The session's open roll call",
      response: RollCallCurrentSchema,
    },
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await currentRollCall(serviceContext(c), caller(c)));
    },
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/roll-call',
      summary: 'Start a roll call, or join the open one',
      response: RollCallSchema,
    },
    async (c) => c.json(await startRollCall(serviceContext(c), caller(c))),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/roll-call/{id}',
      summary: 'A roll call',
      params: IdParamSchema,
      response: RollCallSchema,
    },
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await readRollCall(serviceContext(c), caller(c), c.req.valid('param').id));
    },
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/roll-call/{id}/marks',
      summary: 'Confirm people present or out',
      params: IdParamSchema,
      body: RollCallMarksRequestSchema,
      response: RollCallSchema,
    },
    async (c) =>
      c.json(
        await markRollCall(
          serviceContext(c),
          caller(c),
          c.req.valid('param').id,
          c.req.valid('json').marks,
        ),
      ),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/roll-call/{id}/end',
      summary: 'End a roll call',
      params: IdParamSchema,
      response: RollCallSchema,
    },
    async (c) => c.json(await endRollCall(serviceContext(c), caller(c), c.req.valid('param').id)),
  );
}
