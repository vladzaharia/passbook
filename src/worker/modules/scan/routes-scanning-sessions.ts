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
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import {
  createScanningDevice,
  joinAdminScanningSession,
  updateScanningDevice,
} from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { listScanningSessions } from './scanning-session-list.ts';
import {
  createScanningSession,
  loadScanningSession,
  scanningSessionDetail,
  updateScanningSession,
} from './scanning-sessions.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';

export const scanningSessionsRoutes = createRouter();
guard(scanningSessionsRoutes, requireTenantSession);
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
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const mode = modeOf(auth);
    return c.json(
      await readableScanningPage(ctx, auth, c.req.valid('query'), async (query, authority) =>
        listScanningSessions(
          ctx,
          mode,
          query,
          authority,
          await captureConsoleSessionCountAuthority(ctx, auth, authority),
        ),
      ),
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const authority = await tenantAuthorityOf(ctx, auth, input.orgId, 'scanning:manage');
    const read = await tenantAuthorityOf(ctx, auth, input.orgId, 'scanning:read');
    const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, read);
    return c.json(
      scopedScanningView(
        await createScanningSession(
          ctx,
          currentUserId(c),
          modeOf(auth),
          input,
          authority,
          countAuthority,
        ),
        input.orgId,
      ),
      201,
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const row = await loadScanningSession(ctx, input.sessionId, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.org_id, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await joinAdminScanningSession(
          ctx,
          currentUserId(c),
          modeOf(c.var.auth),
          input,
          new URL(c.req.url).origin,
          authority,
        ),
        row.org_id,
      ),
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const mode = modeOf(auth);
    const row = await loadScanningSession(ctx, c.req.valid('param').id, mode);
    const authority = await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:read');
    const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, authority);
    return c.json(
      scopedScanningView(
        await scanningSessionDetail(ctx, row.id, mode, authority, countAuthority),
        row.org_id,
      ),
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const row = await loadScanningSession(ctx, c.req.valid('param').id, modeOf(auth));
    const authority = await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:manage');
    const read = await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:read');
    const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, read);
    return c.json(
      scopedScanningView(
        await updateScanningSession(
          ctx,
          currentUserId(c),
          row.id,
          c.req.valid('json'),
          authority,
          countAuthority,
        ),
        row.org_id,
      ),
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanningSession(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.org_id, 'scanning:manage');
    return c.json(
      await createScanningDevice(
        ctx,
        currentUserId(c),
        modeOf(c.var.auth),
        row.id,
        c.req.valid('json'),
        new URL(c.req.url).origin,
        authority,
      ),
      201,
    );
  },
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
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanningSession(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.org_id, 'scanning:manage');
    return c.json(
      await updateScanningDevice(
        ctx,
        currentUserId(c),
        row.id,
        c.req.valid('param').deviceId,
        c.req.valid('json'),
        authority,
      ),
    );
  },
);
