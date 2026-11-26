import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { deepFreeze } from './freeze.ts';
import { requireScanActor, scanActorOf } from './guard.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { signOut } from './sign-out.ts';

/** Sign-out on the device API: a Desk-actions monitor may call it too. */
export function registerScanSignOutRoute(scanRoutes: OpenAPIHono<AppBindings>): void {
  scanRoutes.use(
    '/sign-out',
    requireScanActor({ capability: 'passes:operate', screenActions: true }),
  );
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/sign-out',
      summary: 'Sign someone out: out of every place, and collect a lent tag',
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
