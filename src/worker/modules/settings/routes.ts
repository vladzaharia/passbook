import type { Context } from 'hono';
import {
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor, valid } from '../audit/http.ts';
import { listSettings, updateSettings } from './service.ts';

export const settingsRoutes = createRouter();
guard(settingsRoutes, requireAdmin);

function oidcInfo(c: Context<AppBindings>) {
  return {
    issuer: c.env.OIDC_ISSUER,
    adminGroup: c.env.OIDC_ADMIN_GROUP || null,
    userGroup: c.env.OIDC_USER_GROUP || null,
  };
}

register(
  settingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/',
    summary: 'Read settings',
    query: SettingsListQuerySchema,
    response: SettingsListSchema,
  },
  async (c: Context<AppBindings>) => {
    const { scope } = valid<{ scope: string }>(c, 'query');
    return c.json({ items: await listSettings(serviceContext(c), scope), oidc: oidcInfo(c) });
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'put',
    path: '/',
    summary: 'Update settings',
    body: UpdateSettingsSchema,
    response: SettingsListSchema,
  },
  async (c: Context<AppBindings>) => {
    const input = valid<{ scope: string; values: Record<string, unknown> }>(c, 'json');
    const items = await updateSettings(serviceContext(c), requestActor(c), input);
    return c.json({ items, oidc: oidcInfo(c) });
  },
);
