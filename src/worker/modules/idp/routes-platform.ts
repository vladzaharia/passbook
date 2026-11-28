import {
  DriftListSchema,
  FreezeSchema,
  FrozenSchema,
  IdpCallListSchema,
  IdpCallsQuerySchema,
  IdpStatusSchema,
} from '../../../shared/contracts/idp-access.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { ownUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { idpIdempotent } from './idempotent.ts';
import { freezeIdp, idpCalls, idpDrift, idpStatus } from './service-platform.ts';

const TAG = 'polaris platform';

/** Mount at /api/v1/platform. */
export const idpPlatformRoutes = createRouter();
ownUse(idpPlatformRoutes, async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  idpPlatformRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp',
    summary:
      'Polaris ID status: connected, mode, paused, key expiry, budgets, the last SCIM change and open differences.',
    operationId: 'polaris-platform.getPlatformIdp',
    response: IdpStatusSchema,
    auth: { platform: 'platform:status', key: true },
  },
  async (c) => {
    platformActorOf(c);
    return c.json(await idpStatus(serviceContext(c)));
  },
);

register(
  idpPlatformRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/drift',
    summary: 'Open differences between Polaris ID and PassBook.',
    operationId: 'polaris-platform.getPlatformIdpDrift',
    response: DriftListSchema,
    auth: { platform: 'platform:users', key: true },
  },
  async (c) => {
    platformActorOf(c);
    return c.json(await idpDrift(serviceContext(c)));
  },
);

register(
  idpPlatformRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/freeze',
    summary:
      'Pause every Polaris ID change. A person signed in with Polaris ID only: an emergency control, never a key. It is lifted in Polaris ID.',
    operationId: 'polaris-platform.postPlatformIdpFreeze',
    body: FreezeSchema,
    response: FrozenSchema,
    auth: {
      platform: 'platform:users',
      signIn: 'oidc',
      stepUp: { maxAgeSec: STEP_UP_SECONDS },
    },
  },
  (c) => {
    const body = c.req.valid('json');
    return idpIdempotent(c, body, 200, async (ctx) => ({
      result: await freezeIdp(ctx, platformActorOf(c), body.reason),
    }));
  },
);

register(
  idpPlatformRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/calls',
    summary: "The binding's ledger of calls to Polaris ID from `since` (ms), a page at a time.",
    operationId: 'polaris-platform.getPlatformIdpCalls',
    query: IdpCallsQuerySchema,
    response: IdpCallListSchema,
    auth: { platform: 'platform:audit', key: true },
  },
  async (c) => {
    platformActorOf(c);
    const { since, cursor } = c.req.valid('query');
    return c.json(await idpCalls(serviceContext(c), since, cursor));
  },
);
