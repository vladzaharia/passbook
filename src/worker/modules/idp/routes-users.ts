import {
  AccessViewSchema,
  ExternalRoleParamSchema,
  GrantRoleSchema,
  OffboardSchema,
  OffboardStartedSchema,
} from '../../../shared/contracts/idp-access.ts';
import { IdParamSchema } from '../../../shared/contracts/index.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { accessView } from './dto.ts';
import { startOffboard } from './service-offboard.ts';
import { actorOf, removeExternalRole, setPlatformRole } from './service-roles.ts';

const TAG = 'polaris access';
const READ = { platform: 'platform:users' } as const;
/** Changes to who holds a role in Polaris ID: a platform admin signed in with Polaris ID recently. */
const WRITE = {
  platform: 'platform:users',
  signIn: 'oidc',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;

/** Mount at /api/v1/users, before `usersRoutes`. */
export const userAccessRoutes = createRouter();
userAccessRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  userAccessRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}/access',
    summary:
      "A user's Polaris ID access: per role what PassBook wants and why, what Polaris ID showed, and any pause.",
    operationId: 'polaris-access.getUsersByIdAccess',
    params: IdParamSchema,
    response: AccessViewSchema,
    auth: READ,
  },
  async (c) => c.json(await accessView(serviceContext(c), c.req.valid('param').id)),
);

register(
  userAccessRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/roles',
    summary:
      'Grant or revoke a platform role (developer or support). The sync adds or removes the Polaris ID group within a minute.',
    operationId: 'polaris-access.postUsersByIdRoles',
    params: IdParamSchema,
    body: GrantRoleSchema,
    response: AccessViewSchema,
    auth: WRITE,
  },
  async (c) =>
    c.json(
      await setPlatformRole(
        serviceContext(c),
        actorOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);

register(
  userAccessRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/roles/{role}/remove-external',
    summary:
      'Remove a role that was added in Polaris ID, not by PassBook. 409 `IDP_NOT_EXTERNAL` when PassBook did not find it there.',
    operationId: 'polaris-access.postUsersByIdRolesByRoleRemoveExternal',
    params: ExternalRoleParamSchema,
    response: AccessViewSchema,
    auth: WRITE,
  },
  async (c) => {
    const { id, role } = c.req.valid('param');
    return c.json(await removeExternalRole(serviceContext(c), actorOf(c), id, role));
  },
);

register(
  userAccessRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/offboard',
    summary:
      'Offboard a user: end their memberships, developer sponsorships, platform grants and keys, sign them out and disable them, then take their Polaris ID roles away. `dryRun` answers 200 with the plan and changes nothing. Otherwise 202 with the plan and an operation (`idp.offboard`). 409 `IDP_PLATFORM_ADMIN` for a platform admin, `LAST_ORG_ADMIN` when an org would lose its last admin.',
    operationId: 'polaris-access.postUsersByIdOffboard',
    params: IdParamSchema,
    body: OffboardSchema,
    bodyOptional: true,
    status: 202,
    response: OffboardStartedSchema,
    auth: WRITE,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const started = await startOffboard(
      ctx,
      auth,
      c.req.valid('param').id,
      c.req.valid('json').dryRun,
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    if (!started.operation) return c.json(started, 200);
    c.header('location', `/api/v1/operations/${started.operation.id}`);
    return c.json(started, 202);
  },
);
