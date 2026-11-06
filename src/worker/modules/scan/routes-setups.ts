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
import { currentUserId, modeOf, requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { createSetup, listSetups, setupView, startAdminSetup, updateSetup } from './setups.ts';

export const scanSetupsRoutes = createRouter();
guard(scanSetupsRoutes, requireAdmin);
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
  async (c) =>
    c.json(await listSetups(serviceContext(c), modeOf(c.var.auth), c.req.valid('query'))),
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/',
    summary: 'Create a managed scanner or screen',
    body: CreateScannerSetupSchema,
    response: CreatedScannerSetupSchema,
    status: 201,
  },
  async (c) =>
    c.json(
      await createSetup(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
        new URL(c.req.url).origin,
      ),
      201,
    ),
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'post',
    path: '/admin-session',
    summary: 'Create or reuse this admin’s scanner setup',
    body: StartAdminScannerSchema,
    response: AdminScannerStartedSchema,
  },
  async (c) =>
    c.json(
      await startAdminSetup(
        serviceContext(c),
        currentUserId(c),
        modeOf(c.var.auth),
        c.req.valid('json'),
        new URL(c.req.url).origin,
      ),
    ),
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
  async (c) => c.json(await setupView(serviceContext(c), c.req.valid('param').id)),
);
register(
  scanSetupsRoutes,
  'scanners',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update a managed scanner or screen',
    params: IdParamSchema,
    body: UpdateScannerSetupSchema,
    response: ScannerSetupSchema,
  },
  async (c) =>
    c.json(
      await updateSetup(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
