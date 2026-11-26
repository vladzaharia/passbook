import {
  ResolvedSchema,
  ResolveQuerySchema,
  WorkbenchContextsSchema,
  WorkbenchSummaryQuerySchema,
  WorkbenchSummarySchema,
} from '../../../shared/contracts/workbench-read.ts';
import { requireSession } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { resolveId } from '../developer/resolve-service.ts';
import { logCaller } from '../developer/routes-logs.ts';
import { workbenchContexts } from './contexts.ts';
import { workbenchSummary } from './summary.ts';

/** `GET /api/v1/resolve`: what an id is in a Test context. A person's browser, or a try token; never a key. */
export const resolveRoutes = createRouter();
resolveRoutes.use('*', logCaller);
register(
  resolveRoutes,
  'workbench',
  {
    method: 'get',
    path: '/',
    summary: 'What a pasted id is in your Test data: a request, a pass, an event, a key, or Live',
    operationId: 'workbench.getResolve',
    query: ResolveQuerySchema,
    response: ResolvedSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    const { id, orgId } = c.req.valid('query');
    return c.json(await resolveId(serviceContext(c), c.var.auth, id, { orgId }));
  },
);

export const workbenchReadRoutes = createRouter();
workbenchReadRoutes.use('/summary', logCaller);
workbenchReadRoutes.use('/contexts', requireSession);

register(
  workbenchReadRoutes,
  'workbench',
  {
    method: 'get',
    path: '/summary',
    summary: 'Attention counts, the quickstart and a sandbox’s quotas for one Test context',
    operationId: 'workbench.getSummary',
    query: WorkbenchSummaryQuerySchema,
    response: WorkbenchSummarySchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await workbenchSummary(serviceContext(c), c.var.auth, c.req.valid('query')));
  },
);

register(
  workbenchReadRoutes,
  'workbench',
  {
    method: 'get',
    path: '/contexts',
    summary: 'Your sandbox and the organizations where you may use Test, with the tools each shows',
    operationId: 'workbench.getContexts',
    response: WorkbenchContextsSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    c.header('cache-control', 'no-store');
    return c.json(await workbenchContexts(serviceContext(c), auth));
  },
);
