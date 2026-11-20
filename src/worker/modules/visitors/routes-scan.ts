import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { VisitorListSchema } from '../../../shared/contracts/visitors.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deepFreeze } from '../scan/freeze.ts';
import { requireScanActor, scanActorOf } from '../scan/guard.ts';
import { cloneObservedScanActor } from '../scan/scanning-workspace-observation.ts';
import { listVisits } from './service.ts';
import { signOut } from './sign-out.ts';

const DayQuery = z.object({
  dayStart: z.coerce.number().int().nonnegative(),
  dayEnd: z.coerce.number().int().nonnegative(),
});

/** The desk's visitor list and sign-out on the device API: a Desk-actions monitor may call them too. */
export function registerScanVisitorRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use(
    '/sign-out',
    requireScanActor({ capability: 'passes:operate', screenActions: true }),
  );
  scanRoutes.use('/visitors', requireScanActor({ capability: 'scanning:read' }));
  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/visitors',
      summary: "Today's visitors",
      query: DayQuery,
      response: VisitorListSchema,
    },
    async (c) => {
      const actor = scanActorOf(c);
      const { dayStart, dayEnd } = c.req.valid('query');
      return c.json({
        items: await listVisits(serviceContext(c), actor.orgId, actor.mode, 'today', {
          start: dayStart,
          end: dayEnd,
        }),
      });
    },
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/sign-out',
      summary: 'Sign someone out: out of every place they are in, and a visitor checked out',
      body: SignOutRequestSchema,
      response: SignOutResultSchema,
    },
    async (c) =>
      c.json(
        await signOut(
          serviceContext(c),
          deepFreeze(cloneObservedScanActor(scanActorOf(c))),
          c.req.valid('json'),
        ),
      ),
  );
}
