import { z } from 'zod';
import {
  AddUserEmailSchema,
  IdParamSchema,
  OkSchema,
  UpdateUserSchema,
  UserDetailSchema,
  UserListQuerySchema,
  UserListSchema,
  UserSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const usersRoutes = createRouter();
guard(usersRoutes, requireAdmin);

stub(usersRoutes, 'users', {
  method: 'get',
  path: '/',
  summary: 'List users',
  query: UserListQuerySchema,
  response: UserListSchema,
});
stub(usersRoutes, 'users', {
  method: 'get',
  path: '/{id}',
  summary: 'Get a user',
  params: IdParamSchema,
  response: UserDetailSchema,
});
stub(usersRoutes, 'users', {
  method: 'patch',
  path: '/{id}',
  summary: 'Disable or enable a user',
  params: IdParamSchema,
  body: UpdateUserSchema,
  response: UserSchema,
});
stub(usersRoutes, 'users', {
  method: 'post',
  path: '/{id}/emails',
  summary: 'Add a verified email',
  params: IdParamSchema,
  body: AddUserEmailSchema,
  status: 201,
  response: UserDetailSchema,
});
stub(usersRoutes, 'users', {
  method: 'delete',
  path: '/{id}/emails/{email}',
  summary: 'Remove an email',
  params: IdParamSchema.extend({ email: z.string() }),
  response: UserDetailSchema,
});
stub(usersRoutes, 'users', {
  method: 'post',
  path: '/{id}/sessions/revoke',
  summary: 'Revoke all sessions',
  params: IdParamSchema,
  response: OkSchema,
});
