import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  ScanningSessionDetailSchema,
  ScanningSessionListSchema,
  ScanningSessionQuerySchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import {
  captureConsoleSessionCountAuthority,
  keySessionCountAuthority,
} from './scanning-session-dto.ts';
import { listScanningSessions } from './scanning-session-list.ts';
import { loadScanningSession, scanningSessionDetail } from './scanning-sessions.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';
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
