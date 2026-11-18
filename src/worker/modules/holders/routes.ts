import {
  AssignHolderSchema,
  AssignHoldersBulkSchema,
  ClearBlockSchema,
  HolderListQuerySchema,
  HolderListSchema,
  HolderSchema,
  IdParamSchema,
  OkSchema,
  ReassignHolderSchema,
  UnassignHolderSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import {
  actorFor,
  authOf,
  type C,
  passScopeOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { tenantPassForRead } from '../passes/pass-access.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';
import {
  assignHolder,
  assignHoldersBulk,
  clearBlock,
  getHolder,
  listHolders,
  reassignHolder,
  unassignHolder,
} from './service.ts';

function holderAuthority(c: C) {
  return async (orgId: string) => {
    try {
      return await tenantAuthorityOf(svc(c), authOf(c), orgId, 'passes:operate');
    } catch (error) {
      if (error instanceof ForbiddenError)
        throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
      throw error;
    }
  };
}

export const holdersRoutes = createRouter();
guard(
  holdersRoutes,
  requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'holders:write' })),
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'get',
    path: '/',
    summary: 'List holder assignments',
    query: HolderListQuerySchema,
    response: HolderListSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const q = c.req.valid('query');
    const auth = authOf(c);
    const orgId = q.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
    if (!orgId)
      throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'passes:read');
    const page = await listHolders(ctx, { ...q, orgId, mode: modeOf(c.var.auth) });
    if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
      throw new ForbiddenError();
    return c.json(page);
  },
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a holder assignment and any pending transfer',
    params: IdParamSchema,
    response: HolderSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const id = c.req.valid('param').id;
    const { scope, pass } = await tenantPassForRead(ctx, authOf(c), id, passScopeOf(c));
    const authority = await tenantAuthorityOf(ctx, authOf(c), pass.orgId, 'passes:read');
    const holder = await getHolder(ctx, id, scope);
    if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
      throw new ForbiddenError();
    await tenantPassForRead(ctx, authOf(c), id, scope);
    return c.json(holder);
  },
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/assign',
    summary: 'Set the holder email of an unowned pass',
    body: AssignHolderSchema,
    response: HolderSchema,
  },
  async (c) =>
    c.json(
      await assignHolder(
        svc(c),
        actorFor(c),
        c.req.valid('json'),
        passScopeOf(c),
        holderAuthority(c),
      ),
    ),
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/assign-bulk',
    summary: 'Assign up to 100 holders',
    body: AssignHoldersBulkSchema,
    response: HolderListSchema,
  },
  async (c) => {
    const { items } = c.req.valid('json');
    return c.json({
      items: await assignHoldersBulk(
        svc(c),
        actorFor(c),
        items,
        passScopeOf(c),
        holderAuthority(c),
      ),
      nextCursor: null,
    });
  },
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/reassign',
    summary: 'Stage a holder reassignment',
    body: ReassignHolderSchema,
    response: HolderSchema,
  },
  async (c) =>
    c.json(
      await reassignHolder(
        svc(c),
        actorFor(c),
        c.req.valid('json'),
        passScopeOf(c),
        holderAuthority(c),
      ),
    ),
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/unassign',
    summary: 'Stage removal of the holder',
    body: UnassignHolderSchema,
    response: HolderSchema,
  },
  async (c) =>
    c.json(
      await unassignHolder(
        svc(c),
        actorFor(c),
        c.req.valid('json').passId,
        passScopeOf(c),
        holderAuthority(c),
      ),
    ),
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/clear-block',
    summary: 'Allow a user to be attached again',
    body: ClearBlockSchema,
    response: OkSchema,
  },
  async (c) => {
    await clearBlock(svc(c), actorFor(c), c.req.valid('json'), passScopeOf(c), holderAuthority(c));
    return c.json({ ok: true });
  },
);
