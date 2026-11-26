import type { Context } from 'hono';
import {
  RotateScimSchema,
  SetupStatusSchema,
  StartSetupSchema,
} from '../../../shared/contracts/idp-setup.ts';
import { StartedOperationSchema } from '../../../shared/contracts/operations.ts';
import { platformActorOf } from '../../platform/actor.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { startRotate, startSetup } from './ops-start.ts';
import { readSetup } from './setup-read.ts';

const TAG = 'polaris setup';
/** A platform admin signed in with Polaris ID recently, or a Platform key: `platform:settings` writes. */
const WRITE = {
  platform: 'platform:settings',
  // A Platform key may run both: it never meets a step-up (the mint was it) and only tightens PassBook's own app.
  key: true,
  signIn: 'oidc',
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;

/** The admin session or Platform key the gate admitted, checked for the write scope. */
function callerOf(c: Context<AppBindings>): SessionAuth | ApiKeyAuth {
  platformActorOf(c, { scope: 'platform:settings' });
  const auth = c.var.auth;
  if (auth?.kind !== 'session' && auth?.kind !== 'api_key') throw new UnauthenticatedError();
  return auth;
}

/** Mount at /api/v1/platform. */
export const idpSetupRoutes = createRouter();
idpSetupRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  idpSetupRoutes,
  TAG,
  {
    method: 'get',
    path: '/idp/setup',
    summary:
      'What Polaris ID setup has done and what is left: each item is done, needed (`after:<item>` waits for another) or blocked with a reason. Costs one Polaris ID read.',
    operationId: 'polaris-setup.getPlatformIdpSetup',
    response: SetupStatusSchema,
    // §3.5 names `platform:status` for sessions. `platform:status` is not a key scope yet, so a key reads with `platform:read` until PK-2a makes it mintable; the join reconciles it.
    auth: { platform: 'platform:status', key: true },
  },
  async (c) => c.json(await readSetup(serviceContext(c))),
);

register(
  idpSetupRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/setup',
    summary:
      'Set up Polaris ID: groups, the PassBook app and the SCIM connection. A dry run unless `dryRun` is false; a dry run writes nothing. Stops at the first blocked item. Answers 202 with an operation (`idp.setup`).',
    operationId: 'polaris-setup.postPlatformIdpSetup',
    body: StartSetupSchema,
    bodyOptional: true,
    status: 202,
    response: StartedOperationSchema,
    auth: WRITE,
  },
  async (c) => {
    const auth = callerOf(c);
    const operation = await startSetup(
      serviceContext(c),
      auth,
      // An empty body skips validation: parse again so the default stays a dry run.
      StartSetupSchema.parse(c.req.valid('json') ?? {}),
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

register(
  idpSetupRoutes,
  TAG,
  {
    method: 'post',
    path: '/idp/scim-token/rotate',
    summary:
      'Replace the SCIM token: Polaris ID gets the new one first, then PassBook switches, with no gap. A dry run unless `dryRun` is false. Answers 202 with an operation (`idp.scim_rotate`).',
    operationId: 'polaris-setup.postPlatformIdpScimTokenRotate',
    body: RotateScimSchema,
    bodyOptional: true,
    status: 202,
    response: StartedOperationSchema,
    auth: WRITE,
  },
  async (c) => {
    const auth = callerOf(c);
    const operation = await startRotate(
      serviceContext(c),
      auth,
      RotateScimSchema.parse(c.req.valid('json') ?? {}).dryRun,
      idempotencyKeyHeader(c.req.header('idempotency-key')),
    );
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);
