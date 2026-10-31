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
import { actorFor, assertOrg, type C, orgScopeOf, svc, valid } from '../passes/http.ts';
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
  async (c: C) => {
    const q = valid<z.infer<typeof HolderListQuerySchema>>(c, 'query');
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
  async (c: C) =>
    c.json(
      await assignHolder(
        svc(c),
        actorFor(c),
        valid<z.infer<typeof AssignHolderSchema>>(c, 'json'),
        orgScopeOf(c),
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
  async (c: C) => {
    const { items } = valid<z.infer<typeof AssignHoldersBulkSchema>>(c, 'json');
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
  async (c: C) =>
    c.json(
      await reassignHolder(
        svc(c),
        actorFor(c),
        valid<z.infer<typeof ReassignHolderSchema>>(c, 'json'),
        orgScopeOf(c),
      ),
    ),
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
  async (c: C) =>
    c.json(
      await unassignHolder(
        svc(c),
        actorFor(c),
        valid<z.infer<typeof UnassignHolderSchema>>(c, 'json').passId,
        orgScopeOf(c),
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
  async (c: C) => {
    await clearBlock(
      svc(c),
      actorFor(c),
      valid<z.infer<typeof ClearBlockSchema>>(c, 'json'),
      orgScopeOf(c),
    );
    return c.json({ ok: true });
  },
);
