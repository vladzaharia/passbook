import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ScanSessionOpenedSchema,
  ScanSessionOpenNowSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { openNowOnScanner } from './session-hold.ts';

/** Open now at the door: `/api/v1/scan/session/open-now`. Managers only; the service refuses the rest. */
export function registerScanSessionHoursRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/session/open-now',
      summary: 'Open the session early (Manager)',
      body: ScanSessionOpenNowSchema,
      response: ScanSessionOpenedSchema,
    },
    async (c) =>
      c.json(await openNowOnScanner(serviceContext(c), scanActorOf(c), c.req.valid('json'))),
  );
}
