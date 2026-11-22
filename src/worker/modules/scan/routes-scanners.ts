import {
  IdParamSchema,
  ScannerListQuerySchema,
  ScannerListSchema,
  ScannerSamplePassSchema,
  ScannerSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import { pairHere } from './pairing-token.ts';
import { setScannerCookie } from './routes-pair.ts';
import {
  RestoreQuerySchema,
  registerScannerCredentials,
  restoreOf,
} from './routes-scanners-credentials.ts';
import { registerScannerWrites } from './routes-scanners-key.ts';
import { createSamplePass } from './sample-pass.ts';
import { listScanners, loadScanner, scannerView } from './scanner-views.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';
import { scannerAuthority } from './target-authority.ts';

/** Console scanners: /api/v1/scanners. Mode comes from the console's header, never the body. */
export const scannersRoutes = createRouter();
/** Edit and revoke take a console session or a `scanning:write` key, so they register before the session guard. */
registerScannerWrites(scannersRoutes);
registerScannerCredentials(scannersRoutes);
guard(scannersRoutes, requireTenantSession);
scannersRoutes.use('*', limitBody(64 * 1024));

const TAG = 'scanners';
const _originOf = (url: string) => new URL(url).origin;

register(
  scannersRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'List scanners',
    query: ScannerListQuerySchema,
    response: ScannerListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const mode = modeOf(c.var.auth);
    return c.json(
      await readableScanningPage(ctx, authOf(c), c.req.valid('query'), (query, authority) =>
        listScanners(ctx, mode, query, authority),
      ),
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a scanner',
    params: IdParamSchema,
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    await scannerAuthority(ctx, authOf(c), row.orgId, 'scanning:read');
    return c.json(scopedScanningView(await scannerView(ctx, row.id), row.orgId));
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/pair-here',
    summary: 'Make this browser the scanner',
    params: IdParamSchema,
    query: RestoreQuerySchema,
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await scannerAuthority(ctx, authOf(c), row.orgId, 'scanning:manage');
    const issued = await pairHere(
      ctx,
      currentUserId(c),
      row,
      c.req.header('user-agent'),
      authority,
      restoreOf(c.req.valid('query')),
    );
    const view = scopedScanningView(await scannerView(ctx, row.id), row.orgId);
    setScannerCookie(c, issued.token);
    return c.json(view);
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/sample-pass',
    summary: 'A test pass for a test scanner',
    params: IdParamSchema,
    status: 201,
    response: ScannerSamplePassSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id);
    const auth = { ...authOf(c), mode: 'test' as const };
    const authority = await scannerAuthority(ctx, auth, row.orgId, 'scanning:manage');
    const passAuthority = await scannerAuthority(ctx, auth, row.orgId, 'passes:operate');
    return c.json(
      await createSamplePass(ctx, currentUserId(c), row.id, authority, passAuthority),
      201,
    );
  },
);
