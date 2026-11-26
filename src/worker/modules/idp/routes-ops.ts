import { HoldParamSchema, ReconcileIdpSchema } from '../../../shared/contracts/idp-ops.ts';
import { StartedOperationSchema } from '../../../shared/contracts/operations.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { callerOf, startBreakerClear, startCheck, startRestore } from './ops-start.ts';

const TAG = 'polaris operations';
/** Platform admins signed in with Polaris ID recently, never break-glass. Without `key` a key gets 403 PERSON_REQUIRED. */
const PERSON = {
  platform: 'platform:users',
  signIn: 'oidc',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;
/** The check now (or its dry run) is bounded and reversible: a Platform key may start it. */
const AUTH = { ...PERSON, key: true } as const;

const noStore = (router: ReturnType<typeof createRouter>) =>
  router.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

/** Mount at /api/v1/users, before `usersRoutes`. */
export const userHoldRoutes = createRouter();
noStore(userHoldRoutes);

register(
  userHoldRoutes,
  TAG,
  {
    method: 'delete',
    path: '/{id}/holds/{role}',
    summary:
      'Restore a role the Polaris ID owner paused: clears the pause and adds the role again. Answers 202 with an operation (`idp.restore`).',
    operationId: 'polaris-operations.deleteUsersByIdHoldsByRole',
    params: HoldParamSchema,
    status: 202,
    response: StartedOperationSchema,
    auth: PERSON,
  },
  async (c) => {
    const { id, role } = c.req.valid('param');
    const operation = await startRestore(
      serviceContext(c),
      callerOf(c),
      id,
      role,
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

/** Mount at /api/v1/platform. */
export const idpOperationRoutes = createRouter();
noStore(idpOperationRoutes);

register(
  idpOperationRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/reconcile',
    summary:
      'Check now: compare every Polaris ID group with PassBook. `dryRun` records differences and changes nothing. Answers 202 with an operation (`idp.check` or `idp.dry_run`).',
    operationId: 'polaris-operations.postPlatformIdpReconcile',
    body: ReconcileIdpSchema,
    bodyOptional: true,
    status: 202,
    response: StartedOperationSchema,
    auth: AUTH,
  },
  async (c) => {
    const operation = await startCheck(
      serviceContext(c),
      callerOf(c),
      c.req.valid('json').dryRun,
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

register(
  idpOperationRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/scim-breaker/clear',
    summary:
      'Clear the latched SCIM breaker, so the next minute ends the sessions it held back. 409 `IDP_BREAKER_CLOSED` when it is not tripped. Answers 202 with an operation (`idp.breaker_clear`).',
    operationId: 'polaris-operations.postPlatformIdpScimBreakerClear',
    status: 202,
    response: StartedOperationSchema,
    auth: PERSON,
  },
  async (c) => {
    const operation = await startBreakerClear(
      serviceContext(c),
      callerOf(c),
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);
