import { OkSchema } from '../../../shared/contracts/common.ts';
import {
  EndWorkbenchTokenQuerySchema,
  MintWorkbenchTokenSchema,
  WorkbenchTokenSchema,
} from '../../../shared/contracts/workbench.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import {
  createRouter,
  type RouteContext,
  type RouteSpec,
  register,
} from '../../platform/openapi.ts';
import { ownUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { assertConsoleGroup, assertDeveloper } from '../../platform/sign-in-guard.ts';
import { endWorkbenchTokens, issueWorkbenchToken, mintTarget } from './service.ts';

/** /api/v1/workbench. A person's own calls: a token never mints or ends a token (bearers are ignored here). */
export const workbenchRoutes = createRouter();
ownUse(workbenchRoutes, async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});

const AUTH = { human: true, signIn: 'strict' } as const;

function sessionOf(c: { var: AppBindings['Variables'] }): SessionAuth {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth;
}

/**
 * The person may work in the org: a sandbox needs developer access and is exempt from the console group
 * (`ownSandboxExempt`); a regular org needs the console group where it is required.
 */
async function targetFor<S extends RouteSpec>(c: RouteContext<S>, orgId: string) {
  const session = sessionOf(c);
  const target = await mintTarget(serviceContext(c), session, orgId);
  if (target.sandbox) assertDeveloper(c, session);
  assertConsoleGroup(c, session, { orgId, ownSandbox: target.own_sandbox });
  return { session, target };
}

register(
  workbenchRoutes,
  'workbench',
  {
    method: 'post',
    path: '/token',
    summary: 'A 15-minute Workbench token for one org, Test only, bound to this session',
    operationId: 'workbench.postToken',
    auth: AUTH,
    body: MintWorkbenchTokenSchema,
    status: 201,
    response: WorkbenchTokenSchema,
  },
  async (c) => {
    const { session, target } = await targetFor(c, c.req.valid('json').orgId);
    return c.json(await issueWorkbenchToken(serviceContext(c), session, target), 201);
  },
);

register(
  workbenchRoutes,
  'workbench',
  {
    method: 'delete',
    path: '/token',
    summary: "End this session's Workbench tokens for the org",
    operationId: 'workbench.deleteToken',
    auth: AUTH,
    query: EndWorkbenchTokenQuerySchema,
    response: OkSchema,
  },
  async (c) => {
    const { session, target } = await targetFor(c, c.req.valid('query').orgId);
    await endWorkbenchTokens(serviceContext(c), session, target);
    return c.json({ ok: true as const });
  },
);
