import {
  CreateScanEventSchema,
  IdParamSchema,
  pageOf,
  ScanEventAssignSchema,
  ScanEventListQuerySchema,
  ScanEventSchema,
  UpdateScanEventSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, modeOf, requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  archiveEvent,
  assignScanners,
  createEvent,
  eventView,
  listEvents,
  updateEvent,
} from './events.ts';

/** Console events: /api/v1/scan-events. Mode comes from the console's header, never the body. */
export const scanEventsRoutes = createRouter();
guard(scanEventsRoutes, requireAdmin);
scanEventsRoutes.use('*', limitBody(64 * 1024));

const TAG = 'scan-events';

register(
  scanEventsRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'List scan events',
    query: ScanEventListQuerySchema,
    response: pageOf(ScanEventSchema),
  },
  async (c) =>
    c.json(await listEvents(serviceContext(c), modeOf(c.var.auth), c.req.valid('query'))),
);
register(
  scanEventsRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Create a scan event',
    body: CreateScanEventSchema,
    status: 201,
    response: ScanEventSchema,
  },
  async (c) =>
    c.json(
      await createEvent(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
      ),
      201,
    ),
);
register(
  scanEventsRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a scan event',
    params: IdParamSchema,
    response: ScanEventSchema,
  },
  async (c) => c.json(await eventView(serviceContext(c), c.req.valid('param').id)),
);
register(
  scanEventsRoutes,
  TAG,
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Edit a scan event',
    params: IdParamSchema,
    body: UpdateScanEventSchema,
    response: ScanEventSchema,
  },
  async (c) =>
    c.json(
      await updateEvent(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  scanEventsRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/archive',
    summary: 'Archive a scan event (its scanners are detached)',
    params: IdParamSchema,
    response: ScanEventSchema,
  },
  async (c) =>
    c.json(await archiveEvent(serviceContext(c), currentUserId(c), c.req.valid('param').id)),
);
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
  async (c) =>
    c.json(
      await assignScanners(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
