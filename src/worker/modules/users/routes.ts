import type { Context } from 'hono';
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
import { currentUserId, requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  addVerifiedEmail,
  getUserDetail,
  listUsers,
  removeEmail,
  revokeUserSessions,
  setUserStatus,
} from './service.ts';

type C = Context<AppBindings>;
const id = (c: C) => c.req.param('id') ?? '';

export const usersRoutes = createRouter();
guard(usersRoutes, requireAdmin);

register(
  usersRoutes,
  'users',
  {
    method: 'get',
    path: '/',
    summary: 'List users',
    query: UserListQuerySchema,
    response: UserListSchema,
  },
  async (c: C) =>
    c.json(await listUsers(serviceContext(c), UserListQuerySchema.parse(c.req.query()))),
);
register(
  usersRoutes,
  'users',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a user',
    params: IdParamSchema,
    response: UserDetailSchema,
  },
  async (c: C) => c.json(await getUserDetail(serviceContext(c), id(c))),
);
register(
  usersRoutes,
  'users',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Disable or enable a user',
    params: IdParamSchema,
    body: UpdateUserSchema,
    response: UserSchema,
  },
  async (c: C) => {
    const { status } = UpdateUserSchema.parse(await c.req.json());
    return c.json(await setUserStatus(serviceContext(c), currentUserId(c), id(c), status));
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'post',
    path: '/{id}/emails',
    summary: 'Add a verified email',
    params: IdParamSchema,
    body: AddUserEmailSchema,
    status: 201,
    response: UserDetailSchema,
  },
  async (c: C) => {
    const { email } = AddUserEmailSchema.parse(await c.req.json());
    return c.json(await addVerifiedEmail(serviceContext(c), currentUserId(c), id(c), email), 201);
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'delete',
    path: '/{id}/emails/{email}',
    summary: 'Remove an email',
    params: IdParamSchema.extend({ email: z.string() }),
    response: UserDetailSchema,
  },
  async (c: C) =>
    c.json(
      await removeEmail(serviceContext(c), currentUserId(c), id(c), c.req.param('email') ?? ''),
    ),
);
register(
  usersRoutes,
  'users',
  {
    method: 'post',
    path: '/{id}/sessions/revoke',
    summary: 'Revoke all sessions',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: C) => {
    await revokeUserSessions(serviceContext(c), currentUserId(c), id(c));
    return c.json({ ok: true as const });
  },
);
