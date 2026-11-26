import { ApiScopeSchema } from '../../../shared/contracts/common.ts';
import {
  OperationListQuerySchema,
  OperationListSchema,
  OperationParamsSchema,
  OperationSchema,
} from '../../../shared/contracts/operations.ts';
import { OrgCapabilitySchema } from '../../../shared/contracts/org-membership.ts';
import { isPlatformScope, scopeExercises } from '../../platform/api-scopes.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { etagOf } from './dto.ts';
import { getOperation, listOperations } from './service.ts';
import { cancelOperation, mayAct, retryOperation } from './service-act.ts';

const authOf = (c: { var: { auth?: AuthContext } }): AuthContext => {
  if (!c.var.auth) throw new UnauthenticatedError();
  return c.var.auth;
};

const TENANT_SCOPES = ApiScopeSchema.options.filter(
  (s) => !isPlatformScope(s) && s !== 'scans:write',
);
const CAPABILITIES = OrgCapabilitySchema.options;
/**
 * A key may call the route with a scope some kind reads or writes with; the service then checks the one
 * operation's own kind, and answers 404 when the key's scopes do not reach it.
 */
const READ_SCOPES = TENANT_SCOPES.filter((s) =>
  CAPABILITIES.some((cap) => cap.endsWith(':read') && scopeExercises(s, cap)),
);
const WRITE_SCOPES = TENANT_SCOPES.filter((s) =>
  CAPABILITIES.some((cap) => !cap.endsWith(':read') && scopeExercises(s, cap)),
);

/** Mount at /api/v1/operations. */
export const operationsRoutes = createRouter();

const stepUp = {
  maxAgeSec: STEP_UP_SECONDS,
  when: (c: Parameters<typeof serviceContext>[0]) =>
    mayAct(serviceContext(c), authOf(c), c.req.param('id') ?? ''),
};

const unchanged = (header: string | undefined, etag: string) =>
  (header ?? '')
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''))
    .some((v) => v === etag || v === '*');

register(
  operationsRoutes,
  'operations',
  {
    method: 'get',
    path: '/{id}',
    summary:
      'Read an operation. An unchanged revision answers 304 when If-None-Match carries its ETag',
    params: OperationParamsSchema,
    response: OperationSchema,
    auth: { scope: READ_SCOPES },
  },
  async (c) => {
    const op = await getOperation(serviceContext(c), authOf(c), c.req.valid('param').id);
    const etag = etagOf(op);
    const headers = { etag, 'cache-control': 'private, no-cache' };
    if (unchanged(c.req.header('if-none-match'), etag))
      return new Response(null, { status: 304, headers });
    return c.json(op, 200, headers);
  },
);

register(
  operationsRoutes,
  'operations',
  {
    method: 'get',
    path: '/',
    summary:
      'List operations: started by you, in an organization you read, or platform-wide for admins',
    query: OperationListQuerySchema,
    response: OperationListSchema,
    auth: { scope: READ_SCOPES },
  },
  async (c) => c.json(await listOperations(serviceContext(c), authOf(c), c.req.valid('query'))),
);

register(
  operationsRoutes,
  'operations',
  {
    method: 'post',
    path: '/{id}/cancel',
    summary: 'Stop an operation: a queued one at once, a running one at its next safe point',
    params: OperationParamsSchema,
    response: OperationSchema,
    auth: { scope: WRITE_SCOPES, stepUp },
    codes: ['OPERATION_NOT_CANCELABLE'],
  },
  async (c) => c.json(await cancelOperation(serviceContext(c), authOf(c), c.req.valid('param').id)),
);

register(
  operationsRoutes,
  'operations',
  {
    method: 'post',
    path: '/{id}/retry',
    summary: 'Retry a failed operation under the same id with the next attempt',
    params: OperationParamsSchema,
    response: OperationSchema,
    auth: { scope: WRITE_SCOPES, stepUp },
    codes: ['OPERATION_NOT_RETRYABLE', 'OPERATION_RUNNING'],
  },
  async (c) =>
    c.json(
      await retryOperation(
        serviceContext(c),
        authOf(c),
        c.req.valid('param').id,
        idempotencyKeyHeader(c.req.header('idempotency-key')),
      ),
    ),
);
