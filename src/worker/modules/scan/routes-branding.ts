import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { openScanBrandingLogo } from './branding.ts';
import { scanActorOf } from './guard.ts';

/** `v` is the logo's content hash: it only busts caches, the server always serves the current logo. */
const BrandingLogoQuery = z.object({
  v: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/** Register on the guarded scanner router, after the `/branding/logo` read guard. */
export function registerScanBrandingRoute(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'scan',
    {
      method: 'get',
      path: '/branding/logo',
      summary: 'Scanner organization logo',
      query: BrandingLogoQuery,
    },
    async (c) =>
      openScanBrandingLogo(serviceContext(c), scanActorOf(c), c.req.header('if-none-match')),
  );
}
