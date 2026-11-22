import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  AdminScannerStartedSchema,
  CreatedScannerSetupSchema,
  CreateScannerSetupSchema,
  ScannerSetupListSchema,
  ScannerSetupSchema,
  StartAdminScannerSchema,
  UpdateScannerSetupSchema,
} from '../../../shared/contracts/scan-setups.ts';
import { ScannerListQuerySchema } from '../../../shared/contracts/scanners.ts';
import { currentUserId, methodScope, modeOf } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSessionOrApiKey, tenantAuthorityOf } from '../passes/http.ts';
import { withoutNames } from './key-names.ts';
import { loadScanner } from './scanner-views.ts';
import { startAdminSetup } from './scanning-sessions.ts';
import { readableScanningPage, scopedScanningView } from './scanning-workspace.ts';
import { listSetups, setupView } from './setup-views.ts';
import { createSetup, updateSetup } from './setups.ts';
import { scannerAuthority } from './target-authority.ts';

export const scanSetupsRoutes = createRouter();
guard(
  scanSetupsRoutes,
  requireTenantSessionOrApiKey(methodScope({ read: 'scan-setup:read', write: 'scan-setup:write' })),
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'get',
    path: '/',
    summary: 'Managed scanner and screen setups',
    query: ScannerListQuerySchema,
    response: ScannerSetupListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const mode = modeOf(c.var.auth);
    // A key is bound to its own org: readableScanningPage answers a platform key 404, as every scanning list does.
    const page = await readableScanningPage(
      ctx,
      authOf(c),
      c.req.valid('query'),
      (query, authority) => listSetups(ctx, mode, query, authority),
    );
    return c.json(
      authOf(c).kind === 'api_key' ? { ...page, items: page.items.map(withoutNames) } : page,
    );
  },
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/',
    summary: 'Create a managed scanner or screen',
    auth: { human: true },
    body: CreateScannerSetupSchema,
    response: CreatedScannerSetupSchema,
    status: 201,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const authority = await tenantAuthorityOf(ctx, authOf(c), input.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await createSetup(
          ctx,
          currentUserId(c),
          modeOf(c.var.auth),
          input,
          new URL(c.req.url).origin,
          authority,
        ),
        input.orgId,
      ),
      201,
    );
  },
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/admin-session',
    summary: 'Create or reuse this admin’s scanner setup',
    auth: { human: true },
    body: StartAdminScannerSchema,
    response: AdminScannerStartedSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const authority = await tenantAuthorityOf(ctx, authOf(c), input.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await startAdminSetup(
          ctx,
          currentUserId(c),
          modeOf(c.var.auth),
          input,
          new URL(c.req.url).origin,
          authority,
        ),
        input.orgId,
      ),
    );
  },
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Scanner setup and view settings',
    params: IdParamSchema,
    response: ScannerSetupSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const caller = authOf(c);
    if (caller.kind === 'api_key' && caller.orgId !== row.orgId)
      throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
    await scannerAuthority(ctx, authOf(c), row.orgId, 'scanning:read');
    const view = scopedScanningView(await setupView(ctx, row.id), row.orgId);
    return c.json(authOf(c).kind === 'api_key' ? withoutNames(view) : view);
  },
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update a managed scanner or screen',
    auth: { human: true },
    params: IdParamSchema,
    body: UpdateScannerSetupSchema,
    response: ScannerSetupSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const row = await loadScanner(ctx, c.req.valid('param').id, modeOf(c.var.auth));
    const authority = await scannerAuthority(ctx, authOf(c), row.orgId, 'scanning:manage');
    return c.json(
      scopedScanningView(
        await updateSetup(ctx, currentUserId(c), row.id, c.req.valid('json'), authority),
        row.orgId,
      ),
    );
  },
);
