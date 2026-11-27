import type { Context } from 'hono';
import {
  OrgEntitlementsParamsSchema,
  OrgEntitlementsSchema,
  OrgOwnEntitlementsSchema,
  SetOrgEntitlementsSchema,
} from '../../../shared/contracts/entitlement-admin.ts';
import {
  EntitlementPresetsSchema,
  SetEntitlementPresetResultSchema,
  SetEntitlementPresetSchema,
} from '../../../shared/contracts/entitlement-presets.ts';
import { OrgPlanParamsSchema, OrgPlanSchema } from '../../../shared/contracts/org-plan.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { peekBody, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';
import { requireNotPersonal, requireNotPersonalFor } from './personal-guard.ts';
import { listPresets, setPreset } from './presets-service.ts';
import { orgsOnPreset } from './repo-presets.ts';
import { readOrgEntitlements, setOrgEntitlements } from './service-entitlements.ts';
import { readOwnEntitlements } from './service-own-entitlements.ts';
import { readOrgPlan } from './service-plan.ts';

const noStore = async (
  c: { header: (name: string, value: string) => void },
  next: () => Promise<void>,
) => {
  await next();
  c.header('cache-control', 'no-store');
};

/**
 * Mount at /api/v1/platform. What an organization may use: only a platform admin reads the whole state (with
 * the other presets and the notes) and writes it. Entitlements are never writable by the org itself.
 */
export const platformEntitlementsRoutes = createRouter();
// Only these paths: a sub-router's `*` would wrap every route under the mount, branding images included.
platformEntitlementsRoutes.use('/orgs/:id/entitlements', noStore);
platformEntitlementsRoutes.use('/entitlement-presets', noStore);

// An edit that changes values moves every organization on the preset: a fresh sign-in, once it reaches any.
const presetReachesOrgs = async (c: Context<AppBindings>) => {
  const { preset, values } = await peekBody(c);
  if (typeof preset !== 'string' || values === null || typeof values !== 'object') return false;
  if (Object.keys(values).length === 0) return false;
  return (await orgsOnPreset(c.env.DB, preset)) > 0;
};

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/orgs/{id}/entitlements',
    summary: "Read an organization's features: preset, overrides and the presets to choose from",
    params: OrgEntitlementsParamsSchema,
    response: OrgEntitlementsSchema,
    auth: { platform: 'platform:orgs', key: true },
  },
  async (c) => {
    const { id } = c.req.valid('param');
    // A key is nobody's owner: a personal org's features are its owner's.
    await requireNotPersonalFor(c.env.DB, id, platformActorOf(c).userId ?? '');
    return c.json(await readOrgEntitlements(serviceContext(c), id));
  },
);

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'put',
    path: '/orgs/{id}/entitlements',
    summary: "Set an organization's preset and overrides, against the revision the caller read",
    params: OrgEntitlementsParamsSchema,
    body: SetOrgEntitlementsSchema,
    response: OrgEntitlementsSchema,
    auth: { platform: 'platform:orgs', key: true },
  },
  async (c) => {
    await requireNotPersonal(c.env.DB, c.req.valid('param').id);
    return c.json(
      await setOrgEntitlements(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
        platformActorOf(c, { scope: 'platform:orgs' }),
      ),
    );
  },
);

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/entitlement-presets',
    summary: 'Read every preset with its values and the organizations on it',
    response: EntitlementPresetsSchema,
    auth: { platform: 'platform:orgs', key: true },
  },
  async (c) => c.json({ presets: await listPresets(serviceContext(c)) }),
);

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'put',
    path: '/entitlement-presets',
    summary:
      'Change a preset, then move the organizations on it (a bounded number per call; repeat with no values to continue)',
    body: SetEntitlementPresetSchema,
    response: SetEntitlementPresetResultSchema,
    auth: {
      platform: 'platform:orgs',
      key: true,
      stepUp: { maxAgeSec: STEP_UP_SECONDS, when: presetReachesOrgs },
    },
  },
  async (c) =>
    c.json(
      await setPreset(
        serviceContext(c),
        requestActor(c),
        platformActorOf(c, { scope: 'platform:orgs' }),
        c.req.valid('json'),
      ),
    ),
);

/** Mount at /api/v1/orgs. An organization's admins and `org:read` keys see their own features, read-only. */
export const orgEntitlementsRoutes = createRouter();
orgEntitlementsRoutes.use('/:id/entitlements', noStore);
orgEntitlementsRoutes.use('/:id/plan', noStore);

register(
  orgEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/{id}/entitlements',
    summary: "Read the organization's own features",
    params: OrgEntitlementsParamsSchema,
    response: OrgOwnEntitlementsSchema,
    auth: { scope: 'org:read', capability: 'org:read' },
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const ctx = serviceContext(c);
    const authority = await tenantAuthorityOf(ctx, authOf(c), id, 'org:read');
    if (authority.orgId !== id) throw new ForbiddenError();
    return c.json(await readOwnEntitlements(ctx, id));
  },
);

register(
  orgEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/{id}/plan',
    summary: "Read the organization's plan: limits with use, features and the footer rule",
    params: OrgPlanParamsSchema,
    response: OrgPlanSchema,
    auth: { scope: 'org:read', capability: 'org:read' },
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const ctx = serviceContext(c);
    const authority = await tenantAuthorityOf(ctx, authOf(c), id, 'org:read');
    if (authority.orgId !== id) throw new ForbiddenError();
    return c.json(await readOrgPlan(ctx, id, modeOf(authOf(c))));
  },
);
