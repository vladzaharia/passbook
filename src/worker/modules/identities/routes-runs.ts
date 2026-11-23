import {
  IdentityRunListQuerySchema,
  IdentityRunListSchema,
  IdentityRunSchema,
  IdParamSchema,
  OrgIdParamSchema,
  StartManagedIdentitySchema,
} from '../../../shared/contracts/index.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { authOf } from '../passes/http.ts';
import {
  isPlatformAdmin,
  requireOrgAccess,
  requireOrgAccessOr404,
  requirePlatformAdmin,
} from './access.ts';
import {
  cancelRun,
  listRuns,
  requireRun,
  retryRun,
  startManagedIdentity,
  toRunDto,
} from './runs-service.ts';

const HUMAN = { human: true, requestMode: true } as const;

/** Mount at /api/v1/identity-runs. A member reads and retries their own organization's runs. */
export const identityRunsRoutes = createRouter();

register(
  identityRunsRoutes,
  'identity runs',
  {
    method: 'get',
    path: '/',
    summary: 'List identity runs, newest first',
    query: IdentityRunListQuerySchema,
    response: IdentityRunListSchema,
    auth: HUMAN,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    if (!isPlatformAdmin(c) && !query.orgId)
      throw new ValidationError('Choose an organization.', [], 'ORG_REQUIRED');
    await requireOrgAccess(ctx, c, query.orgId, 'integrations:read');
    return c.json(await listRuns(ctx, query));
  },
);

register(
  identityRunsRoutes,
  'identity runs',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an identity run',
    params: IdParamSchema,
    response: IdentityRunSchema,
    auth: HUMAN,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const run = await requireRun(ctx, c.req.valid('param').id);
    await requireOrgAccessOr404(ctx, c, run.org_id, 'integrations:read', 'IDENTITY_RUN_NOT_FOUND');
    return c.json(toRunDto(run));
  },
);

register(
  identityRunsRoutes,
  'identity runs',
  {
    method: 'post',
    path: '/{id}/retry',
    summary: 'Start a failed or canceled run again',
    params: IdParamSchema,
    status: 202,
    response: IdentityRunSchema,
    auth: HUMAN,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const run = await requireRun(ctx, c.req.valid('param').id);
    await requireOrgAccessOr404(ctx, c, run.org_id, 'org:manage', 'IDENTITY_RUN_NOT_FOUND');
    return c.json(await retryRun(ctx, requestActor(c), run), 202);
  },
);

register(
  identityRunsRoutes,
  'identity runs',
  {
    method: 'post',
    path: '/{id}/cancel',
    summary: 'Cancel an open run',
    params: IdParamSchema,
    response: IdentityRunSchema,
    auth: HUMAN,
  },
  async (c) => {
    requirePlatformAdmin(c);
    const ctx = serviceContext(c);
    return c.json(
      await cancelRun(ctx, requestActor(c), await requireRun(ctx, c.req.valid('param').id)),
    );
  },
);

/** Mount at /api/v1/orgs. */
export const identityProvisionRoutes = createRouter();

register(
  identityProvisionRoutes,
  'identity runs',
  {
    method: 'post',
    path: '/{orgId}/identities/apple',
    summary: 'Start the managed Apple identity of an organization (Idempotency-Key)',
    params: OrgIdParamSchema,
    body: StartManagedIdentitySchema,
    status: 202,
    response: IdentityRunSchema,
    auth: { ...HUMAN, feature: 'identity.managed', stepUp: { maxAgeSec: STEP_UP_SECONDS } },
  },
  async (c) => {
    const ctx = serviceContext(c);
    const { orgId } = c.req.valid('param');
    const body = c.req.valid('json');
    await requireOrgAccess(ctx, c, orgId, 'org:manage');
    // The handle is reserved for good: only a platform admin picks one, an org gets its slug's.
    if (body.handle && !isPlatformAdmin(c))
      throw new ForbiddenError(
        'Only PassBook can choose the handle.',
        'IDENTITY_HANDLE_ADMIN_ONLY',
      );
    const auth = authOf(c);
    return idempotentJson(
      c,
      ctx,
      { orgId, mode: auth.mode, principal: principalOf(auth), body: { orgId, ...body } },
      202,
      () => startManagedIdentity(ctx, requestActor(c), orgId, body.handle),
    );
  },
);
