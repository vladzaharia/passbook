import { z } from 'zod';
import {
  AddEmailRequestSchema,
  IdParamSchema,
  MyEmailListSchema,
  MyPassListSchema,
  MyPassSchema,
  MySessionListSchema,
  OkSchema,
  PageQuerySchema,
  RefreshResponseSchema,
  RemovePassResponseSchema,
} from '../../../shared/contracts/index.ts';
import { requireSession } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const meRoutes = createRouter();
guard(meRoutes, requireSession);
stub(meRoutes, 'me', {
  method: 'get',
  path: '/passes',
  summary: 'My passes',
  query: PageQuerySchema,
  response: MyPassListSchema,
});
stub(meRoutes, 'me', {
  method: 'get',
  path: '/passes/{id}',
  summary: 'One of my passes',
  params: IdParamSchema,
  response: MyPassSchema,
});
stub(meRoutes, 'me', {
  method: 'post',
  path: '/passes/{id}/refresh',
  summary: 'Force refresh (3/min per pass)',
  params: IdParamSchema,
  status: 202,
  response: RefreshResponseSchema,
});
stub(meRoutes, 'me', {
  method: 'delete',
  path: '/passes/{id}',
  summary: 'Remove from my passes (blocks re-attach)',
  params: IdParamSchema,
  response: RemovePassResponseSchema,
});
stub(meRoutes, 'me', {
  method: 'get',
  path: '/emails',
  summary: 'My emails',
  response: MyEmailListSchema,
});
stub(meRoutes, 'me', {
  method: 'post',
  path: '/emails',
  summary: 'Add an email and send a verification link',
  body: AddEmailRequestSchema,
  status: 202,
  response: OkSchema,
});
stub(meRoutes, 'me', {
  method: 'delete',
  path: '/emails/{email}',
  summary: 'Remove an email',
  params: z.object({ email: z.string() }),
  response: MyEmailListSchema,
});
stub(meRoutes, 'me', {
  method: 'get',
  path: '/sessions',
  summary: 'My sessions',
  response: MySessionListSchema,
});
stub(meRoutes, 'me', {
  method: 'delete',
  path: '/sessions/{id}',
  summary: 'Revoke one of my sessions',
  params: IdParamSchema,
  response: OkSchema,
});
