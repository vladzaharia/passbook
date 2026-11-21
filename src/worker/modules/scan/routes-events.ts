import {
  IdParamSchema,
  ScanEventAssignSchema,
  ScanEventSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { type C, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority, eventTarget } from './events.ts';
import { assignScanners } from './events-mutations.ts';
import { registerEventWrites } from './routes-events-write.ts';
import { registerConsoleInsideRoutes } from './routes-occupancy-console.ts';

/** Console events: /api/v1/scan-events. Mode comes from the console's header, never the body. */
export const scanEventsRoutes = createRouter();
/** Create, edit and archive take a console session or a `scanning:write` key, so they register before the session guard. */
registerEventWrites(scanEventsRoutes);
guard(scanEventsRoutes, requireTenantSession);
scanEventsRoutes.use('*', limitBody(64 * 1024));

const TAG = 'scan-events';
registerConsoleInsideRoutes(scanEventsRoutes, TAG, 'event');

async function eventAuthority(c: C, id: string, capability: 'scanning:read' | 'scanning:manage') {
  const ctx = serviceContext(c);
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const event = await eventTarget(ctx, id);
  if (!event || event.mode !== modeOf(auth) || !(await getOrgAccess(ctx, auth.userId, event.orgId)))
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  const authority = await captureEventAuthority(
    ctx,
    auth,
    await tenantAuthorityOf(ctx, auth, event.orgId, capability),
  );
  return { ctx, authority };
}

register(
  scanEventsRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/scanners',
    summary: 'Move scanners onto a scan event',
    params: IdParamSchema,
    body: ScanEventAssignSchema,
    response: ScanEventSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const { ctx, authority } = await eventAuthority(c, id, 'scanning:manage');
    return c.json(await assignScanners(ctx, currentUserId(c), id, c.req.valid('json'), authority));
  },
);
