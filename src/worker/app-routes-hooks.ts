import type { Hono } from 'hono';
import { hooksRoutes } from './modules/connections/routes.ts';
import { scimRoutes } from './modules/idp/scim-routes.ts';
import type { AppBindings } from './platform/context.ts';

type Mount = readonly [path: string, routes: Hono<AppBindings>];

/**
 * Inbound provider hooks and SCIM. Mount order sets the order of the OpenAPI components, so the groups interleave with the
 * other files as listed in app.ts. Append a line to the group it belongs with.
 */
export const hooksMounts: readonly (readonly Mount[])[] = [
  [
    ['/hooks', hooksRoutes],
    ['/scim/v2', scimRoutes],
  ],
];
