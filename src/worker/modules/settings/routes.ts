import {
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const settingsRoutes = createRouter();
guard(settingsRoutes, requireAdmin);
stub(settingsRoutes, 'settings', {
  method: 'get',
  path: '/',
  summary: 'Read settings',
  query: SettingsListQuerySchema,
  response: SettingsListSchema,
});
stub(settingsRoutes, 'settings', {
  method: 'put',
  path: '/',
  summary: 'Update settings',
  body: UpdateSettingsSchema,
  response: SettingsListSchema,
});
