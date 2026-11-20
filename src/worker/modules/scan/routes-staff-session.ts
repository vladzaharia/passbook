import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { CursorQuerySchema } from '../../../shared/contracts/common.ts';
import {
  type ScanSession,
  ScanSessionSchema,
  ScanStaffSearchSchema,
  ScanStaffSignInSchema,
} from '../../../shared/contracts/scan-session.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { searchStaff, signInStaff, signOutStaff } from './staff-session.ts';

const RosterQuery = z.object({ q: z.string().trim().min(1).max(80) });

export function registerScanStaffRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/staff',
      summary: 'Search the staff roster of this scanner',
      query: RosterQuery.extend(CursorQuerySchema.shape),
      response: ScanStaffSearchSchema,
    },
    async (c) =>
      c.json(await searchStaff(serviceContext(c), scanActorOf(c), c.req.valid('query').q)),
  );

  // A cookie-paired browser reads its CSRF secret back from the session it just changed.
  const withCsrf = (auth: AuthContext | undefined, session: ScanSession) => {
    if (auth?.kind === 'scanner' && auth.transport === 'cookie')
      session.csrfToken = auth.csrfSecret;
    return session;
  };

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/staff',
      summary: 'Sign in staff on this scanner',
      body: ScanStaffSignInSchema,
      response: ScanSessionSchema,
    },
    async (c) =>
      c.json(
        withCsrf(
          c.var.auth,
          await signInStaff(serviceContext(c), scanActorOf(c), c.req.valid('json')),
        ),
      ),
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'delete',
      path: '/staff',
      summary: 'Sign out staff on this scanner',
      response: ScanSessionSchema,
    },
    async (c) =>
      c.json(withCsrf(c.var.auth, await signOutStaff(serviceContext(c), scanActorOf(c)))),
  );
}
