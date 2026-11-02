import type { z } from 'zod';
import {
  AssignHolderSchema,
  AssignHoldersBulkSchema,
  ClearBlockSchema,
  HolderListQuerySchema,
  HolderListSchema,
  HolderSchema,
  OkSchema,
  ReassignHolderSchema,
  UnassignHolderSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { actorFor, assertOrg, type C, orgScopeOf, svc } from '../passes/http.ts';
import {
  assignHolder,
  assignHoldersBulk,
  clearBlock,
  listHolders,
  reassignHolder,
  unassignHolder,
} from './service.ts';

export const holdersRoutes = createRouter();
guard(
  holdersRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'holders:write' })),
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
    const q = c.req.valid('query');
    if (q.orgId) assertOrg(c, q.orgId);
    const orgId = orgScopeOf(c) ?? q.orgId;
    return c.json(await listHolders(svc(c), { ...q, orgId }));
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
  async (c) => c.json(await assignHolder(svc(c), actorFor(c), c.req.valid('json'), orgScopeOf(c))),
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
      items: await assignHoldersBulk(svc(c), actorFor(c), items, orgScopeOf(c)),
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
    summary: 'Reassign an owned pass (clears the owner)',
    body: ReassignHolderSchema,
    response: HolderSchema,
  },
  async (c) =>
    c.json(await reassignHolder(svc(c), actorFor(c), c.req.valid('json'), orgScopeOf(c))),
);

register(
  holdersRoutes,
  'holders',
  {
    method: 'post',
    path: '/unassign',
    summary: 'Remove the holder',
    body: UnassignHolderSchema,
    response: HolderSchema,
  },
  async (c) =>
    c.json(await unassignHolder(svc(c), actorFor(c), c.req.valid('json').passId, orgScopeOf(c))),
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
    await clearBlock(svc(c), actorFor(c), c.req.valid('json'), orgScopeOf(c));
    return c.json({ ok: true });
  },
);
