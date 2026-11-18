import type { OpenAPIHono } from '@hono/zod-openapi';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { ScanMarkOutRequestSchema } from '../../../shared/contracts/scan-occupancy.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deepFreeze } from './freeze.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { markOut } from './occupancy/mark-out.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Occupancy actions on the device API: a Desk-actions monitor may call them too. */
export function registerScanOccupancyRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use(
    '/mark-out',
    requireScanActor({ capability: 'passes:operate', screenActions: true }),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/mark-out',
      summary: 'Mark someone as out',
      body: ScanMarkOutRequestSchema,
      response: ScanOutcomeSchema,
    },
    async (c) =>
      c.json(
        await markOut(
          serviceContext(c),
          deepFreeze(cloneObservedScanActor(scanActorOf(c))),
          c.req.valid('json'),
        ),
      ),
  );
}
