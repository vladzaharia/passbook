import { z } from 'zod';
import {
  CreatedScannerSchema,
  CreateScannerSchema,
  IdParamSchema,
  ScannerListQuerySchema,
  ScannerListSchema,
  ScannerModeSchema,
  ScannerPairingSchema,
  ScannerPairingStateSchema,
  ScannerSamplePassSchema,
  ScannerSchema,
  TerminalTokenSchema,
  UpdateScannerSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { createPairing, pairingState } from './pairing.ts';
import { pairHere, replaceTerminalToken } from './pairing-token.ts';
import { setScannerCookie } from './routes-pair.ts';
import { createSamplePass } from './sample-pass.ts';
import { changeMode } from './scanner-mode.ts';
import { listScanners, loadScanner, scannerView } from './scanner-views.ts';
import { createScanner, updateScanner } from './scanners.ts';
import { revokeScanner } from './scanning-devices.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';

/** Console scanners: /api/v1/scanners. Mode comes from the console's header, never the body. */
export const scannersRoutes = createRouter();
guard(scannersRoutes, requireTenantSession);
scannersRoutes.use('*', limitBody(64 * 1024));

const TAG = 'scanners';
/** `?restore=true` lets a pairing, pair-here or token call bring a removed scanner back (audited). */
const RestoreQuerySchema = z.object({ restore: z.enum(['true']).optional() });
const restoreOf = (q: z.infer<typeof RestoreQuerySchema>) => q.restore === 'true';
const originOf = (url: string) => new URL(url).origin;

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
      await readableScanningPage(ctx, authOf(c), c.req.valid('query'), (query) =>
        listScanners(ctx, mode, query),
      ),
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Create a scanner (a device comes with a pairing code)',
    body: CreateScannerSchema,
    status: 201,
    response: CreatedScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const authority = await tenantAuthorityOf(ctx, authOf(c), input.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await createScanner(
          ctx,
          currentUserId(c),
          modeOf(c.var.auth),
          input,
          originOf(c.req.url),
          authority,
        ),
        input.orgId,
      ),
      201,
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
    await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:read');
    return c.json(scopedScanningView(await scannerView(ctx, row.id), row.orgId));
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Edit a scanner',
    params: IdParamSchema,
    body: UpdateScannerSchema,
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await updateScanner(ctx, currentUserId(c), row.id, c.req.valid('json'), authority),
        row.orgId,
      ),
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/pairing',
    summary: 'A new pairing code (replaces any live one)',
    params: IdParamSchema,
    query: RestoreQuerySchema,
    response: ScannerPairingSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      await createPairing(
        ctx,
        currentUserId(c),
        row,
        originOf(c.req.url),
        authority,
        restoreOf(c.req.valid('query')),
      ),
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/pairing',
    summary: 'Poll a pairing',
    params: IdParamSchema,
    response: ScannerPairingStateSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:read');
    return c.json(pairingState(row, ctx.clock.now()));
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
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
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
    path: '/{id}/token',
    summary: 'A till token, shown once (replaces the old one)',
    params: IdParamSchema,
    query: RestoreQuerySchema,
    response: TerminalTokenSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      await replaceTerminalToken(
        ctx,
        currentUserId(c),
        row,
        authority,
        restoreOf(c.req.valid('query')),
      ),
      200,
      {
        'cache-control': 'no-store',
      },
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/revoke',
    summary: 'Remove a scanner from use',
    params: IdParamSchema,
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(await revokeScanner(ctx, currentUserId(c), row.id, authority), row.orgId),
    );
  },
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/mode',
    summary: 'Go live or move to test mode',
    params: IdParamSchema,
    body: ScannerModeSchema,
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await tenantAuthorityOf(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await changeMode(ctx, currentUserId(c), row.id, c.req.valid('json'), authority),
        row.orgId,
      ),
    );
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
    const authority = await tenantAuthorityOf(ctx, auth, row.orgId, 'scanning:manage');
    const passAuthority = await tenantAuthorityOf(ctx, auth, row.orgId, 'passes:operate');
    return c.json(
      await createSamplePass(ctx, currentUserId(c), row.id, authority, passAuthority),
      201,
    );
  },
);
