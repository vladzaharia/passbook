import type { Context } from 'hono';
import { z } from 'zod';
import {
  CreateOrgSchema,
  IdParamSchema,
  OkSchema,
  OrgListQuerySchema,
  OrgListSchema,
  OrgSchema,
  OrgStatusSchema,
  PlatformOrgSummarySchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import type { OrgAdmin } from './repo-org-writes.ts';
import { isPersonalOrg } from './repo-personal.ts';
import { createOrg, deleteOrg, getOrg, listOrgs, setOrgStatus } from './service.ts';

// Platform provisioning deliberately exposes only the directory projection, not workspace data.
const PlatformOrgListSchema = OrgListSchema.extend({ items: z.array(PlatformOrgSummarySchema) });

/**
 * Mount inside `orgsRoutes`, ahead of its tenant guard. Person-only (`{ platform }` with no `key`): the services take
 * the signed-in admin, and a Platform key gets 403 PERSON_REQUIRED.
 */
export const orgsPlatformRoutes = createRouter();

/** The signed-in admin session: the gate proved it, and the platform grant re-checks it at commit. */
export function adminOf(c: Context<AppBindings>): OrgAdmin {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return { userId: auth.userId, sessionId: auth.sessionId };
}

register(
  orgsPlatformRoutes,
  'orgs',
  {
    auth: { platform: 'platform:orgs' },
    method: 'get',
    path: '/',
    summary: 'List organizations (personal organizations are never listed)',
    query: OrgListQuerySchema,
    response: PlatformOrgListSchema,
  },
  async (c) => {
    const page = await listOrgs(serviceContext(c), c.req.valid('query'), modeOf(c.var.auth));
    return c.json({ ...page, items: page.items.map((org) => PlatformOrgSummarySchema.parse(org)) });
  },
);

register(
  orgsPlatformRoutes,
  'orgs',
  {
    auth: { platform: 'platform:orgs' },
    method: 'post',
    path: '/',
    summary: 'Create an organization',
    body: CreateOrgSchema,
    status: 201,
    response: OrgSchema,
  },
  async (c) =>
    c.json(
      await createOrg(serviceContext(c), requestActor(c), c.req.valid('json'), adminOf(c)),
      201,
    ),
);

register(
  orgsPlatformRoutes,
  'orgs',
  {
    auth: { platform: 'platform:orgs' },
    method: 'get',
    path: '/{id}',
    summary: 'Get an organization for platform provisioning',
    params: IdParamSchema,
    response: PlatformOrgSummarySchema,
  },
  async (c) =>
    c.json(
      PlatformOrgSummarySchema.parse(
        await getOrg(serviceContext(c), c.req.valid('param').id, modeOf(c.var.auth), adminOf(c)),
      ),
    ),
);

register(
  orgsPlatformRoutes,
  'orgs',
  {
    method: 'post',
    // Suspending a personal org is the platform's break-glass: a fresh sign-in.
    auth: {
      platform: 'platform:orgs',
      stepUp: {
        maxAgeSec: STEP_UP_SECONDS,
        when: (c) => isPersonalOrg(c.env.DB, c.req.param('id') ?? ''),
      },
    },
    path: '/{id}/status',
    summary: 'Suspend or reactivate an organization',
    params: IdParamSchema,
    body: OrgStatusSchema,
    response: PlatformOrgSummarySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    await setOrgStatus(ctx, requestActor(c), id, c.req.valid('json').status, adminOf(c));
    return c.json(
      PlatformOrgSummarySchema.parse(
        await getOrg(ctx, id, modeOf(c.var.auth), { ...adminOf(c), afterStatus: true }),
      ),
    );
  },
);

register(
  orgsPlatformRoutes,
  'orgs',
  {
    auth: { platform: 'platform:orgs' },
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an organization',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await deleteOrg(serviceContext(c), requestActor(c), c.req.valid('param').id, adminOf(c));
    return c.json({ ok: true });
  },
);
