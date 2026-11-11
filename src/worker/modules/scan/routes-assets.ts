import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { openScannerAsset } from './asset-service.ts';
import { scanActorOf } from './guard.ts';

/** Register on the guarded scanner router, so the device credential remains mandatory. */
export function registerScanAssetRoute(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'scan',
    {
      method: 'get',
      path: '/passes/{passId}/assets/{name}',
      summary: 'Pass image, with a grant',
      // Service enforces the previous bounds and masks invalid values as ASSET_NOT_FOUND.
      params: z.object({ passId: z.string(), name: z.string() }),
      query: z.object({ g: z.string().optional() }),
    },
    async (c) => {
      const { passId, name } = c.req.valid('param');
      return openScannerAsset(
        serviceContext(c),
        scanActorOf(c),
        passId,
        name,
        c.req.valid('query').g,
      );
    },
  );
}
