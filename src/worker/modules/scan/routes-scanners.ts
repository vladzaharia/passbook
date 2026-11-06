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
import { currentUserId, modeOf, requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { createPairing, pairingState } from './pairing.ts';
import { pairHere, replaceTerminalToken } from './pairing-token.ts';
import { setScannerCookie } from './routes-pair.ts';
import {
  changeMode,
  createSamplePass,
  createScanner,
  listScanners,
  loadScanner,
  revokeScanner,
  scannerView,
  updateScanner,
} from './scanners.ts';

/** Console scanners: /api/v1/scanners. Mode comes from the console's header, never the body. */
export const scannersRoutes = createRouter();
guard(scannersRoutes, requireAdmin);
scannersRoutes.use('*', limitBody(64 * 1024));

const TAG = 'scanners';
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
  async (c) =>
    c.json(await listScanners(serviceContext(c), modeOf(c.var.auth), c.req.valid('query'))),
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
  async (c) =>
    c.json(
      await createScanner(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
        originOf(c.req.url),
      ),
      201,
    ),
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
  async (c) => c.json(await scannerView(serviceContext(c), c.req.valid('param').id)),
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
  async (c) =>
    c.json(
      await updateScanner(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  scannersRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/pairing',
    summary: 'A new pairing code (replaces any live one)',
    params: IdParamSchema,
    response: ScannerPairingSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id);
    return c.json(await createPairing(ctx, currentUserId(c), row, originOf(c.req.url)));
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
    const row = await loadScanner(ctx, c.req.valid('param').id);
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
    response: ScannerSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id);
    const issued = await pairHere(ctx, currentUserId(c), row, c.req.header('user-agent'));
    setScannerCookie(c, issued.token);
    return c.json(await scannerView(ctx, row.id));
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
    response: TerminalTokenSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id);
    return c.json(await replaceTerminalToken(ctx, currentUserId(c), row), 200, {
      'cache-control': 'no-store',
    });
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
  async (c) =>
    c.json(await revokeScanner(serviceContext(c), currentUserId(c), c.req.valid('param').id)),
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
  async (c) =>
    c.json(
      await changeMode(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
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
  async (c) =>
    c.json(
      await createSamplePass(serviceContext(c), currentUserId(c), c.req.valid('param').id),
      201,
    ),
);
