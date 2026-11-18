import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { ScanRoleChangeSchema, ScanRoleStaffSchema } from '../../../shared/contracts/scan-role.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { changeRole, unlockRoster } from './role.ts';

export function registerScanRoleRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/role',
      summary: 'Show this phone to a customer, or switch it back to scanning',
      body: ScanRoleChangeSchema,
      response: ScanSessionSchema,
    },
    async (c) => {
      const auth = c.var.auth;
      const csrf = auth?.kind === 'scanner' && auth.transport === 'cookie' ? auth.csrfSecret : null;
      const session = await changeRole(
        serviceContext(c),
        scanActorOf(c),
        c.req.valid('json'),
        csrf,
      );
      return c.json(session);
    },
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/role/staff',
      summary: 'Find who is unlocking this phone',
      query: z.object({ q: z.string().trim().min(1).max(80) }),
      response: ScanRoleStaffSchema,
    },
    async (c) =>
      c.json(await unlockRoster(serviceContext(c), scanActorOf(c), c.req.valid('query').q)),
  );
}
