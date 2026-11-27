import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  ApproveCliSchema,
  CliSessionReviewSchema,
  CliSessionStartedSchema,
  CliTokenPollSchema,
  CliTokenSchema,
  LookupCliCodeSchema,
  RevokeCliTokensSchema,
  RevokedCliTokensSchema,
  StartCliSessionSchema,
} from '../../../shared/contracts/cli.ts';
import { IdParamSchema, OkSchema } from '../../../shared/contracts/common.ts';
import { CLI_TOKEN_PREFIX } from '../../platform/api-key-token.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { apiKeyMissing, bearerOf, keyCaller } from '../../platform/auth.ts';
import { resolveBearer } from '../../platform/auth-workbench.ts';
import type { AppBindings } from '../../platform/context.ts';
import { noteKeyRefused } from '../../platform/denied.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import {
  createRouter,
  type RouteContext,
  type RouteSpec,
  register,
} from '../../platform/openapi.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  assertConsoleGroup,
  assertDeveloper,
  STEP_UP_SECONDS,
} from '../../platform/sign-in-guard.ts';
import { approveCliSession } from './cli-approve.ts';
import { logoutCliToken, revokeCliTokens } from './cli-revoke.ts';
import {
  type CliMeta,
  denyCliSession,
  lookupCliCode,
  pollCliSession,
  startCliSession,
} from './cli-service.ts';
import { mintTarget } from './service.ts';

/** /api/v1/cli. Sign-in for the command line: no CORS, no cache, and a bearer approves nothing. */
export const cliRoutes = createRouter();
cliRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});

/** A bearer is never a person: `Authorization` of any kind on a route the page calls is refused, whatever the cookie. */
const noBearer = createMiddleware<AppBindings>(async (c, next) => {
  if (c.req.header('authorization')) throw new UnauthenticatedError();
  await next();
});
cliRoutes.use('/sessions/lookup', noBearer);
cliRoutes.use('/sessions/:id/approve', noBearer);
cliRoutes.use('/sessions/:id/deny', noBearer);

/** The person approving: a Polaris ID session (never break-glass or an email link), with CSRF. */
const PERSON = { human: true, signIn: 'oidc' } as const;
const APPROVER = { ...PERSON, stepUp: { maxAgeSec: STEP_UP_SECONDS } } as const;

/** What the server saw: the network, and where Cloudflare places it. Never what the client claims. */
function metaOf(c: Context<AppBindings>): CliMeta {
  const cf = (c.req.raw as { cf?: { country?: unknown; city?: unknown } }).cf;
  const text = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 64) : null);
  return {
    ipPrefix: ipPrefix(clientIp(c)),
    ratePrefix: clientRatePrefix(c),
    country: text(cf?.country),
    city: text(cf?.city),
  };
}

function sessionOf(c: { var: AppBindings['Variables'] }): SessionAuth {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth;
}

register(
  cliRoutes,
  'cli',
  {
    method: 'post',
    path: '/sessions',
    summary: 'Start a CLI sign-in: a device code, and the code the person types',
    operationId: 'cli.postSessions',
    public: true,
    body: StartCliSessionSchema,
    status: 201,
    response: CliSessionStartedSchema,
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_CLI_START', `cli.start:${clientRatePrefix(c)}`);
    return c.json(await startCliSession(serviceContext(c), c.req.valid('json'), metaOf(c)), 201);
  },
);

register(
  cliRoutes,
  'cli',
  {
    method: 'post',
    path: '/sessions/lookup',
    summary: 'What a typed code is: the device, where it started and the account approving',
    operationId: 'cli.postSessionsLookup',
    auth: PERSON,
    body: LookupCliCodeSchema,
    response: CliSessionReviewSchema,
  },
  async (c) =>
    c.json(
      await lookupCliCode(serviceContext(c), sessionOf(c), c.req.valid('json').userCode, metaOf(c)),
    ),
);

/** The context the token reaches: the person's own sandbox (developer role), or an org they may use in Test. */
async function targetFor<S extends RouteSpec>(c: RouteContext<S>, orgId: string) {
  const session = sessionOf(c);
  const target = await mintTarget(serviceContext(c), session, orgId);
  if (target.sandbox) assertDeveloper(c, session);
  assertConsoleGroup(c, session, { orgId, ownSandbox: target.own_sandbox });
  return { session, target };
}

register(
  cliRoutes,
  'cli',
  {
    method: 'post',
    path: '/sessions/{id}/approve',
    summary: 'Approve a CLI sign-in for one context: Test only, 30 days',
    operationId: 'cli.postSessionsByIdApprove',
    auth: APPROVER,
    params: IdParamSchema,
    body: ApproveCliSchema,
    response: OkSchema,
  },
  async (c) => {
    const { session, target } = await targetFor(c, c.req.valid('json').orgId);
    await approveCliSession(serviceContext(c), session, c.req.valid('param').id, target, metaOf(c));
    return c.json({ ok: true as const });
  },
);

register(
  cliRoutes,
  'cli',
  {
    method: 'post',
    path: '/sessions/{id}/deny',
    summary: 'Deny a CLI sign-in',
    operationId: 'cli.postSessionsByIdDeny',
    auth: APPROVER,
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await denyCliSession(serviceContext(c), sessionOf(c), c.req.valid('param').id, metaOf(c));
    return c.json({ ok: true as const });
  },
);

register(
  cliRoutes,
  'cli',
  {
    method: 'post',
    path: '/sessions/token',
    summary: 'Poll a CLI sign-in with its device code: pending, or the token, once',
    operationId: 'cli.postSessionsToken',
    public: true,
    codes: ['CLI_AUTH_PENDING', 'CLI_SLOW_DOWN', 'CLI_CODE_DENIED', 'CLI_CODE_EXPIRED'],
    body: CliTokenPollSchema,
    response: CliTokenSchema,
  },
  async (c) => {
    await enforceRateLimit(c.env, 'RL_CLI_POLL', `cli.poll:${clientRatePrefix(c)}`);
    return c.json(await pollCliSession(serviceContext(c), c.req.valid('json').deviceCode));
  },
);

register(
  cliRoutes,
  'cli',
  {
    method: 'delete',
    path: '/tokens/{id}',
    summary: 'Sign out: a CLI token ends itself. Send it as the bearer.',
    operationId: 'cli.deleteTokensById',
    public: true,
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    // The one `/cli` route a CLI token calls (CLI_LOGOUT_ROUTE): its own id, never another's.
    const sent = bearerOf(c);
    if (sent === null || sent === 'empty' || !sent.token.startsWith(CLI_TOKEN_PREFIX))
      throw apiKeyMissing();
    const key = await resolveBearer(c, sent.token, keyCaller(c), undefined);
    if (key?.kind !== 'api_key' || key.via !== 'cli') {
      noteKeyRefused(c, { code: 'INVALID_API_KEY', token: sent.token });
      throw new UnauthenticatedError('The CLI token is invalid or expired.', 'INVALID_API_KEY');
    }
    await logoutCliToken(serviceContext(c), key, c.req.valid('param').id);
    return c.json({ ok: true as const });
  },
);

/** Mount at /api/v1/platform. The kill switch: a platform admin signed in with Polaris ID, recently. */
export const cliPlatformRoutes = createRouter();
cliPlatformRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});
register(
  cliPlatformRoutes,
  'cli',
  {
    method: 'post',
    path: '/cli-tokens/revoke',
    summary: 'Kill switch: end every CLI token, or those of one organization or person',
    operationId: 'cli.postCliTokensRevoke',
    auth: { platform: 'platform:users', signIn: 'oidc', stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    body: RevokeCliTokensSchema,
    response: RevokedCliTokensSchema,
  },
  async (c) => {
    const admin = sessionOf(c);
    return c.json({
      revoked: await revokeCliTokens(serviceContext(c), admin, c.req.valid('json')),
    });
  },
);
