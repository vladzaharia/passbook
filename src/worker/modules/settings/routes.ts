import type { Context } from 'hono';
import {
  SettingsImpactSchema,
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { listSettings, settingsImpact, updateSettings } from './service.ts';

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
  async (c) => {
    const { scope } = c.req.valid('query');
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
  async (c) => {
    const input = c.req.valid('json');
    const items = await updateSettings(serviceContext(c), requestActor(c), input);
    return c.json({ items, oidc: oidcInfo(c) });
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/impact',
    summary: 'Users who sign in by email only',
    response: SettingsImpactSchema,
  },
  async (c) => c.json(await settingsImpact(serviceContext(c))),
);
