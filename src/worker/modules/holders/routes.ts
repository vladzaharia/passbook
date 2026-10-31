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
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const holdersRoutes = createRouter();
guard(
  holdersRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'holders:write' })),
);

stub(holdersRoutes, 'holders', {
  method: 'get',
  path: '/',
  summary: 'List holder assignments',
  query: HolderListQuerySchema,
  response: HolderListSchema,
});
stub(holdersRoutes, 'holders', {
  method: 'post',
  path: '/assign',
  summary: 'Set the holder email of an unowned pass',
  body: AssignHolderSchema,
  response: HolderSchema,
});
stub(holdersRoutes, 'holders', {
  method: 'post',
  path: '/assign-bulk',
  summary: 'Assign up to 100 holders',
  body: AssignHoldersBulkSchema,
  response: HolderListSchema,
});
stub(holdersRoutes, 'holders', {
  method: 'post',
  path: '/reassign',
  summary: 'Reassign an owned pass (clears the owner)',
  body: ReassignHolderSchema,
  response: HolderSchema,
});
stub(holdersRoutes, 'holders', {
  method: 'post',
  path: '/unassign',
  summary: 'Remove the holder',
  body: UnassignHolderSchema,
  response: HolderSchema,
});
stub(holdersRoutes, 'holders', {
  method: 'post',
  path: '/clear-block',
  summary: 'Allow a user to be attached again',
  body: ClearBlockSchema,
  response: OkSchema,
});
