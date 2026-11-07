import { z } from 'zod';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { AdminScannerStartedSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  CreatedScanningDeviceSchema,
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
  JoinAdminScanningSessionSchema,
  ScanningDeviceSchema,
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
  ScanningSessionQuerySchema,
  UpdateScanningDeviceSchema,
  UpdateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { currentUserId, modeOf, requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  createScanningDevice,
  joinAdminScanningSession,
  updateScanningDevice,
} from './scanning-devices.ts';
import {
  createScanningSession,
  listScanningSessions,
  scanningSessionDetail,
  updateScanningSession,
} from './scanning-sessions.ts';

export const scanningSessionsRoutes = createRouter();
guard(scanningSessionsRoutes, requireAdmin);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'get',
    path: '/',
    summary: 'Scanning sessions',
    query: ScanningSessionQuerySchema,
    response: ScanningSessionListSchema,
  },
  async (c) =>
    c.json(await listScanningSessions(serviceContext(c), modeOf(c.var.auth), c.req.valid('query'))),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/',
    summary: 'Create a shared scanning session',
    body: CreateScanningSessionSchema,
    response: ScanningSessionDetailSchema,
    status: 201,
  },
  async (c) =>
    c.json(
      await createScanningSession(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
      ),
      201,
    ),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/join',
    summary: 'Join a scanning session as an administrator device',
    body: JoinAdminScanningSessionSchema,
    response: AdminScannerStartedSchema,
  },
  async (c) =>
    c.json(
      await joinAdminScanningSession(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
        new URL(c.req.url).origin,
      ),
    ),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Session rules and devices',
    params: IdParamSchema,
    response: ScanningSessionDetailSchema,
  },
  async (c) => c.json(await scanningSessionDetail(serviceContext(c), c.req.valid('param').id)),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update shared session rules',
    params: IdParamSchema,
    body: UpdateScanningSessionSchema,
    response: ScanningSessionDetailSchema,
  },
  async (c) =>
    c.json(
      await updateScanningSession(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/{id}/devices',
    summary: 'Add a device to a scanning session',
    params: IdParamSchema,
    body: CreateScanningDeviceSchema,
    response: CreatedScanningDeviceSchema,
    status: 201,
  },
  async (c) =>
    c.json(
      await createScanningDevice(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('param').id,
        c.req.valid('json'),
        new URL(c.req.url).origin,
      ),
      201,
    ),
);
register(
  scanningSessionsRoutes,
  'scanners',
  {
    method: 'patch',
    path: '/{id}/devices/{deviceId}',
    summary: 'Configure one device',
    params: z.object({ id: z.string().min(1).max(64), deviceId: z.string().min(1).max(64) }),
    body: UpdateScanningDeviceSchema,
    response: ScanningDeviceSchema,
  },
  async (c) =>
    c.json(
      await updateScanningDevice(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('param').deviceId,
        c.req.valid('json'),
      ),
    ),
);
