import type { OpenAPIHono } from '@hono/zod-openapi';
import { ScanRoleChangeSchema } from '../../../shared/contracts/scan-role.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { changeRole } from './role.ts';

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
}
