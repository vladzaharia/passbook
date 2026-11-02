import type { Context } from 'hono';
import { z } from 'zod';
import {
  AddUserEmailSchema,
  IdParamSchema,
  IdSchema,
  OkSchema,
  UpdateUserSchema,
  UserDetailSchema,
  UserListQuerySchema,
  UserListSchema,
  UserSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { addVerifiedEmail, makePrimaryEmail, removeEmail } from './emails.ts';
import { getUserDetail, listUsers, setUserStatus } from './service.ts';
import { revokeUserSession, revokeUserSessions } from './sessions.ts';

type C = Context<AppBindings>;
/** The requester's own session id hash, so the detail can mark "This device". */
const ownSession = (c: C) => (c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '');

export const usersRoutes = createRouter();
guard(usersRoutes, requireAdmin);
usersRoutes.use('*', limitBody(64 * 1024));

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
  async (c) => c.json(await listUsers(serviceContext(c), c.req.valid('query'))),
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
  async (c) =>
    c.json(await getUserDetail(serviceContext(c), c.req.valid('param').id, ownSession(c))),
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
  async (c) => {
    const { status } = c.req.valid('json');
    return c.json(
      await setUserStatus(serviceContext(c), currentUserId(c), c.req.valid('param').id, status),
    );
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
  async (c) => {
    const { email } = c.req.valid('json');
    const ctx = serviceContext(c);
    return c.json(
      await addVerifiedEmail(ctx, currentUserId(c), c.req.valid('param').id, email, ownSession(c)),
      201,
    );
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
  async (c) =>
    c.json(
      await removeEmail(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('param').email,
        ownSession(c),
      ),
    ),
);
register(
  usersRoutes,
  'users',
  {
    method: 'post',
    path: '/{id}/emails/{email}/primary',
    summary: 'Make an email primary',
    params: IdParamSchema.extend({ email: z.string() }),
    response: UserDetailSchema,
  },
  async (c) =>
    c.json(
      await makePrimaryEmail(
        serviceContext(c),
        currentUserId(c),
        c.req.valid('param').id,
        c.req.valid('param').email,
        ownSession(c),
      ),
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
  async (c) => {
    await revokeUserSessions(serviceContext(c), currentUserId(c), c.req.valid('param').id);
    return c.json({ ok: true as const });
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'delete',
    path: '/{id}/sessions/{sessionId}',
    summary: 'Revoke one session',
    params: IdParamSchema.extend({ sessionId: IdSchema }),
    response: OkSchema,
  },
  async (c) => {
    const sessionId = c.req.valid('param').sessionId;
    await revokeUserSession(
      serviceContext(c),
      currentUserId(c),
      c.req.valid('param').id,
      sessionId,
    );
    return c.json({ ok: true as const });
  },
);
