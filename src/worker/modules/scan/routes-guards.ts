import type { OpenAPIHono } from '@hono/zod-openapi';
import { routePath } from 'hono/route';
import type { AppBindings } from '../../platform/context.ts';
import { requireScanActor } from './guard.ts';
import { tillKeyAccess } from './routes-key-access.ts';

/** Which capability guards each device route, by method. */
export function mountScanGuards(router: OpenAPIHono<AppBindings>): void {
  const readActor = requireScanActor({ capability: 'scanning:read' });
  const operateActor = requireScanActor({ capability: 'passes:operate' });
  const manageActor = requireScanActor({ capability: 'scanning:manage' });
  const readSessionActor = requireScanActor({
    capability: 'scanning:read',
    staffOptional: true,
    screens: true,
  });
  const manageSessionActor = requireScanActor({
    capability: 'scanning:manage',
    staffOptional: true,
    screens: true,
  });

  router.use('/session', (c, next) =>
    (c.req.method === 'GET' ? readSessionActor : manageSessionActor)(c, next),
  );
  router.use('/branding/logo', readSessionActor);
  router.use(
    '/device',
    requireScanActor({ capability: 'scanning:manage', staffOptional: true, screens: true }),
  );
  router.use('/role', manageSessionActor);
  router.use('/session/open-now', operateActor);
  router.use(
    '/staff',
    requireScanActor({ capability: 'scanning:manage', staffOptional: true, screenActions: true }),
  );
  router.use('/actions', (c, next) =>
    (c.req.method === 'POST' ? operateActor : manageActor)(c, next),
  );
  // A Desk-actions monitor opens the photos Who's in lists.
  const photoActor = requireScanActor({ capability: 'scanning:read', screenActions: true });
  for (const path of ['/summary', '/stats', '/activity', '/devices'])
    router.use(path, (c, next) => (c.req.method === 'GET' ? readActor : manageActor)(c, next));
  router.use('/passes/*', (c, next) =>
    (c.req.method === 'GET'
      ? photoActor
      : c.req.method === 'POST' && c.req.path.endsWith('/photo')
        ? operateActor
        : manageActor)(c, next),
  );
  for (const path of ['/resolve', '/lookup'])
    router.use(path, (c, next) => (c.req.method === 'POST' ? readActor : manageActor)(c, next));
  // Hono's /scans/* also matches /scans itself, so choose exactly one guard here.
  router.use('/scans/*', (c, next) => {
    const suffix = c.req.path.slice(routePath(c).length - 2);
    if (c.req.method === 'GET' && suffix === '') return readActor(c, next);
    if (c.req.method === 'POST' && /^\/[^/]+\/undo$/.test(suffix)) return operateActor(c, next);
    return manageActor(c, next);
  });
  router.use('*', tillKeyAccess);
}
