import { UpdateSettingsSchema } from '../../../shared/contracts/settings-list.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { oidcInfo, releaseInfo, ScopedSettingsListSchema } from './routes.ts';
import { listSettings, settingsRevision, updateSettings } from './service.ts';
import { changesSignIn, needsPerson } from './sign-in-settings.ts';

const PlatformSettingsUpdateSchema = UpdateSettingsSchema.omit({ scope: true });

/**
 * Mount at /api/v1/platform before the router-level `requireAdmin` of the wallet platform routes, which ignores a
 * Bearer key. The platform scope of `/settings`, for a Platform key as well as a person.
 */
export const platformSettingsRoutes = createRouter();

register(
  platformSettingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/settings',
    summary: 'Read the platform settings',
    response: ScopedSettingsListSchema,
    auth: { platform: 'platform:settings', key: true },
  },
  async (c) => {
    platformActorOf(c);
    const ctx = serviceContext(c);
    return c.json({
      items: await listSettings(ctx, 'platform'),
      ...(await settingsRevision(ctx, 'platform')),
      oidc: oidcInfo(c),
      released: releaseInfo(),
    });
  },
);

register(
  platformSettingsRoutes,
  'settings',
  {
    method: 'put',
    path: '/settings',
    summary:
      'Update the platform settings; sign-in settings (auth.*, oidc.*) are a person signed in with Polaris ID only',
    body: PlatformSettingsUpdateSchema,
    response: ScopedSettingsListSchema,
    auth: {
      platform: 'platform:settings',
      key: { unless: (_c, body) => needsPerson(body) },
      stepUp: {
        maxAgeSec: STEP_UP_SECONDS,
        when: async (c) => changesSignIn((await c.req.json().catch(() => ({}))).values),
      },
    },
  },
  async (c) => {
    const actor = platformActorOf(c, { scope: 'platform:settings' });
    const ctx = serviceContext(c);
    const p = actor.principal;
    const by =
      p.kind === 'api_key'
        ? { keyId: p.keyId, scope: 'platform:settings' as const }
        : p.kind === 'platform'
          ? { userId: p.userId, sessionId: p.sessionIdHash }
          : undefined;
    const items = await updateSettings(
      ctx,
      requestActor(c),
      { scope: 'platform', ...c.req.valid('json') },
      undefined,
      by,
    );
    return c.json({
      items,
      ...(await settingsRevision(ctx, 'platform')),
      oidc: oidcInfo(c),
      released: releaseInfo(),
    });
  },
);
