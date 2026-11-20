import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { CursorQuerySchema } from '../../../shared/contracts/common.ts';
import { VisitorListSchema } from '../../../shared/contracts/visitors.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { policyActor } from '../scan/dto.ts';
import { deepFreeze } from '../scan/freeze.ts';
import { requireScanActor, scanActorOf } from '../scan/guard.ts';
import { scanPolicy } from '../scan/rules.ts';
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
      query: DayQuery.extend(CursorQuerySchema.shape),
      response: VisitorListSchema,
    },
    async (c) => {
      const actor = scanActorOf(c);
      // Desk and above, and only the passes this session's templates admit. Desk notes stay in the console.
      if (!scanPolicy(policyActor(actor), { kind: 'mark_out' }).allow)
        throw new ForbiddenError('Only Desk and above can see visitors.', 'FORBIDDEN');
      const { dayStart, dayEnd } = c.req.valid('query');
      const items = await listVisits(
        serviceContext(c),
        actor.orgId,
        actor.mode,
        'today',
        { start: dayStart, end: dayEnd },
        actor.templateIds,
      );
      return c.json({ items: items.map((v) => ({ ...v, note: null })), nextCursor: null });
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
