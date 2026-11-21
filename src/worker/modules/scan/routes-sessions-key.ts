import { z } from 'zod';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  ScanningDeviceSchema,
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
  ScanningSessionQuerySchema,
  SessionHoldRequestSchema,
  UpdateScanningDeviceSchema,
  UpdateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, type C, type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { updateScanningDevice } from './scanning-devices.ts';
import {
  captureConsoleSessionCountAuthority,
  keySessionCountAuthority,
} from './scanning-session-dto.ts';
import { listScanningSessions } from './scanning-session-list.ts';
import {
  loadScanningSession,
  scanningSessionDetail,
  updateScanningSession,
} from './scanning-sessions.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';
import { holdScanningSession } from './session-hold.ts';
import { sessionAuthority } from './target-authority.ts';

type Router = ReturnType<typeof createRouter>;
const keyOf = (authority: TenantPassWrite) => {
  if (authority.kind !== 'api_key') throw new ForbiddenError();
  return authority;
};
/** No `capability` or `feature`: a read outside the caller's orgs is an empty page, so the handler does not always prove either. */
const READ = { scope: 'scan-setup:read' } as const;

/**
 * List and read sessions as a console session or an org-bound `scan-setup:read` key. A key sees the
 * rules, devices and counts, not the activity feed. Registered before the session guard.
 */
export function registerSessionReads(router: Router): void {
  register(
    router,
    'scanners',
    {
      method: 'get',
      path: '/',
      summary: 'Scanning sessions',
      auth: READ,
      query: ScanningSessionQuerySchema,
      response: ScanningSessionListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const auth = authOf(c);
      if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
      const mode = modeOf(auth);
      return c.json(
        await readableScanningPage(ctx, auth, c.req.valid('query'), async (query, authority) =>
          listScanningSessions(
            ctx,
            mode,
            query,
            authority,
            authority.kind === 'api_key' || auth.kind !== 'session'
              ? keySessionCountAuthority(keyOf(authority))
              : await captureConsoleSessionCountAuthority(ctx, auth, authority),
          ),
        ),
      );
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'get',
      path: '/{id}',
      summary: 'Session rules and devices',
      auth: READ,
      params: IdParamSchema,
      response: ScanningSessionDetailSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const auth = authOf(c);
      if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
      const mode = modeOf(auth);
      const row = await loadScanningSession(ctx, c.req.valid('param').id, mode);
      if (auth.kind === 'api_key') {
        if (auth.orgId !== null && auth.orgId !== row.org_id)
          throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
        const authority = await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:read');
        if (authority.kind !== 'api_key') throw new ForbiddenError();
        return c.json(
          scopedScanningView(
            await scanningSessionDetail(
              ctx,
              row.id,
              mode,
              authority,
              keySessionCountAuthority(authority),
            ),
            row.org_id,
          ),
        );
      }
      const authority = await sessionAuthority(ctx, auth, row.org_id, 'scanning:read');
      const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, authority);
      return c.json(
        scopedScanningView(
          await scanningSessionDetail(ctx, row.id, mode, authority, countAuthority),
          row.org_id,
        ),
      );
    },
  );
}

const WRITE = {
  scope: 'scanning:write',
  capability: 'scanning:manage',
  feature: 'scanning.devices',
} as const;

/**
 * The caller of a write on one session: a console session by membership, or an org-bound
 * `scanning:write` key under its own principal. A key of another org finds no such session.
 */
async function writer(c: C, id: string) {
  const ctx = serviceContext(c);
  const auth = authOf(c);
  if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
  const row = await loadScanningSession(ctx, id, modeOf(auth));
  if (auth.kind === 'api_key') {
    if (auth.orgId !== null && auth.orgId !== row.org_id)
      throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
    const authority = await tenantAuthorityOf(ctx, auth, row.org_id, 'scanning:manage');
    return {
      ctx,
      row,
      mode: modeOf(auth),
      actorId: auth.keyId,
      authority,
      countAuthority: keySessionCountAuthority(keyOf(authority)),
    };
  }
  const authority = await sessionAuthority(ctx, auth, row.org_id, 'scanning:manage');
  const read = await sessionAuthority(ctx, auth, row.org_id, 'scanning:read');
  return {
    ctx,
    row,
    mode: modeOf(auth),
    actorId: currentUserId(c),
    authority,
    countAuthority: await captureConsoleSessionCountAuthority(ctx, auth, read),
  };
}

export function registerSessionWrites(router: Router): void {
  register(
    router,
    'scanners',
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Update shared session rules',
      auth: WRITE,
      params: IdParamSchema,
      body: UpdateScanningSessionSchema,
      response: ScanningSessionDetailSchema,
    },
    async (c) => {
      const w = await writer(c, c.req.valid('param').id);
      return c.json(
        scopedScanningView(
          await updateScanningSession(
            w.ctx,
            w.actorId,
            w.row.id,
            c.req.valid('json'),
            w.authority,
            w.countAuthority,
          ),
          w.row.org_id,
        ),
      );
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/{id}/hold',
      summary: 'Close now, open now or go back to the session hours',
      auth: WRITE,
      params: IdParamSchema,
      body: SessionHoldRequestSchema,
      response: ScanningSessionDetailSchema,
    },
    async (c) => {
      const w = await writer(c, c.req.valid('param').id);
      return c.json(
        scopedScanningView(
          await holdScanningSession(
            w.ctx,
            w.actorId,
            w.row.id,
            c.req.valid('json'),
            w.authority,
            w.countAuthority,
          ),
          w.row.org_id,
        ),
      );
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'patch',
      path: '/{id}/devices/{deviceId}',
      summary: 'Configure one device',
      auth: WRITE,
      params: z.object({ id: z.string().min(1).max(64), deviceId: z.string().min(1).max(64) }),
      body: UpdateScanningDeviceSchema,
      response: ScanningDeviceSchema,
    },
    async (c) => {
      const w = await writer(c, c.req.valid('param').id);
      return c.json(
        await updateScanningDevice(
          w.ctx,
          w.actorId,
          w.row.id,
          c.req.valid('param').deviceId,
          c.req.valid('json'),
          w.authority,
        ),
      );
    },
  );
}
