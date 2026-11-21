import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { ScannerSchema, UpdateScannerSchema } from '../../../shared/contracts/scanners.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, type C, tenantAuthorityOf } from '../passes/http.ts';
import { loadScanner } from './scanner-views.ts';
import { updateScanner } from './scanners.ts';
import { revokeScanner } from './scanning-devices.ts';
import { scopedScanningView } from './scanning-workspace.ts';
import { scannerAuthority } from './target-authority.ts';

type Router = ReturnType<typeof createRouter>;
const WRITE = {
  scope: 'scanning:write',
  capability: 'scanning:manage',
  feature: 'scanning.devices',
} as const;

/**
 * The caller of a write on one scanner: a console session by membership, or an org-bound
 * `scanning:write` key under its own principal. A key of another org finds no such scanner.
 */
async function writer(c: C, id: string) {
  const ctx = serviceContext(c);
  const auth = authOf(c);
  if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
  const row = await loadScanner(ctx, id, modeOf(auth));
  if (auth.kind === 'api_key') {
    if (auth.orgId !== null && auth.orgId !== row.orgId)
      throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
    const authority = await tenantAuthorityOf(ctx, auth, row.orgId, 'scanning:manage');
    if (authority.kind !== 'api_key') throw new ForbiddenError();
    return { ctx, row, actorId: auth.keyId, authority };
  }
  const authority = await scannerAuthority(ctx, auth, row.orgId, 'scanning:manage');
  return { ctx, row, actorId: currentUserId(c), authority };
}

/** Edit and revoke take a console session or a `scanning:write` key; registered before the session guard. */
export function registerScannerWrites(router: Router): void {
  router.use('*', limitBody(64 * 1024));
  register(
    router,
    'scanners',
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Edit a scanner',
      auth: WRITE,
      params: IdParamSchema,
      body: UpdateScannerSchema,
      response: ScannerSchema,
    },
    async (c) => {
      const w = await writer(c, c.req.valid('param').id);
      return c.json(
        scopedScanningView(
          await updateScanner(w.ctx, w.actorId, w.row.id, c.req.valid('json'), w.authority),
          w.row.orgId,
        ),
      );
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/{id}/revoke',
      summary: 'Remove a scanner from use',
      auth: WRITE,
      params: IdParamSchema,
      response: ScannerSchema,
    },
    async (c) => {
      const w = await writer(c, c.req.valid('param').id);
      return c.json(
        scopedScanningView(
          await revokeScanner(w.ctx, w.actorId, w.row.id, w.authority),
          w.row.orgId,
        ),
      );
    },
  );
}
