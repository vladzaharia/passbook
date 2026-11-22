import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { ScanSummarySchema } from '../../../shared/contracts/scan-session.ts';
import { AdminScannerStartedSchema } from '../../../shared/contracts/scan-setups.ts';
import {
  CreateScanningSessionSchema,
  JoinAdminScanningSessionSchema,
  ScanningSessionDetailSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { registerScanSetup } from './routes-scan-setup.ts';
import { registerSessionDevices } from './routes-sessions-devices.ts';
import { registerSessionReads, registerSessionWrites } from './routes-sessions-key.ts';
import { joinAdminScanningSession } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession, loadScanningSession } from './scanning-sessions.ts';
import { scopedScanningView } from './scanning-workspace.ts';
import { consoleSessionSummary } from './summary-session.ts';
import { sessionAuthority } from './target-authority.ts';

export const scanningSessionsRoutes = createRouter();
/** The one-call setup declares its own `auth` (a console session or a `scanning:write` key): it is registered before the session guard, which applies to what follows. */
registerScanSetup(scanningSessionsRoutes);
registerSessionReads(scanningSessionsRoutes);
registerSessionWrites(scanningSessionsRoutes);
registerSessionDevices(scanningSessionsRoutes);
guard(scanningSessionsRoutes, requireTenantSession);
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
    const authority = await sessionAuthority(ctx, authOf(c), row.org_id, 'scanning:manage');
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
    path: '/{id}/summary',
    summary: 'Tonight: the whole session’s totals (Managers)',
    params: IdParamSchema,
    response: ScanSummarySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const mode = modeOf(auth);
    const row = await loadScanningSession(ctx, c.req.valid('param').id, mode);
    const authority = await sessionAuthority(ctx, auth, row.org_id, 'scanning:read');
    const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, authority);
    return c.json(await consoleSessionSummary(ctx, row.id, mode, authority, countAuthority));
  },
);
