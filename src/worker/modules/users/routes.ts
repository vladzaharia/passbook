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
  UserPassesQuerySchema,
  UserPassListSchema,
  UserSchema,
} from '../../../shared/contracts/index.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { currentUserId } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { assertStrictSignIn, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { makePrimaryEmail, removeEmail, requestEmailProof } from './emails.ts';
import { getUserDetail, listUsers, setUserStatus } from './service.ts';
import { revokeUserSession, revokeUserSessions } from './sessions.ts';
import { listPassesOfUser } from './user-passes.ts';

type C = Context<AppBindings>;
/** The requester's own session id hash, so the detail can mark "This device". */
const ownSession = (c: C) => (c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '');

export const usersRoutes = createRouter();
// A Platform key with `platform:users` reaches the reads, the disable and the session revokes. The email routes
// (P4: they move a person's sign-in identity) are person-only: `{ platform }` with no `key`.
const KEY = { platform: 'platform:users', key: true } as const;
usersRoutes.use('*', limitBody(64 * 1024));

register(
  usersRoutes,
  'users',
  {
    method: 'get',
    auth: KEY,
    path: '/',
    summary: 'List users',
    query: UserListQuerySchema,
    response: UserListSchema,
  },
  async (c) =>
    c.json(
      await listUsers(serviceContext(c), c.req.valid('query'), platformActorOf(c).userId ?? ''),
    ),
);
register(
  usersRoutes,
  'users',
  {
    method: 'get',
    auth: KEY,
    path: '/{id}',
    summary: 'Get a user',
    params: IdParamSchema,
    response: UserDetailSchema,
  },
  async (c) =>
    c.json(
      await getUserDetail(
        serviceContext(c),
        c.req.valid('param').id,
        ownSession(c),
        platformActorOf(c).userId ?? '',
      ),
    ),
);
register(
  usersRoutes,
  'users',
  {
    method: 'get',
    auth: KEY,
    path: '/{id}/passes',
    summary: "List a user's passes in every organization",
    params: IdParamSchema,
    query: UserPassesQuerySchema,
    response: UserPassListSchema,
  },
  async (c) => {
    // A support read across organizations: a strong sign-in, whatever the admin role's source (a key's mint was it).
    if (c.var.auth?.kind === 'session') assertStrictSignIn(c, c.var.auth);
    return c.json(
      await listPassesOfUser(
        serviceContext(c),
        platformActorOf(c),
        c.req.valid('param').id,
        c.req.valid('query'),
      ),
    );
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'patch',
    auth: KEY,
    path: '/{id}',
    summary: 'Disable or enable a user',
    params: IdParamSchema,
    body: UpdateUserSchema,
    response: UserSchema,
  },
  async (c) => {
    const { status } = c.req.valid('json');
    const actor = platformActorOf(c, { scope: 'platform:users' });
    const { id } = c.req.valid('param');
    return c.json(await setUserStatus(serviceContext(c), actor, id, status));
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'post',
    // Adding an email to someone's account is how it is taken over: a recent sign-in.
    auth: { platform: 'platform:users', stepUp: { maxAgeSec: STEP_UP_SECONDS } },
    path: '/{id}/emails',
    summary: 'Send an email verification link',
    params: IdParamSchema,
    body: AddUserEmailSchema,
    status: 202,
    response: UserDetailSchema,
  },
  async (c) => {
    const { email } = c.req.valid('json');
    const ctx = serviceContext(c);
    return c.json(
      await requestEmailProof(ctx, currentUserId(c), c.req.valid('param').id, email, ownSession(c)),
      202,
    );
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'delete',
    auth: { platform: 'platform:users' },
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
    auth: { platform: 'platform:users' },
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
    auth: KEY,
    path: '/{id}/sessions/revoke',
    summary: 'Revoke all sessions',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await revokeUserSessions(
      serviceContext(c),
      platformActorOf(c, { scope: 'platform:users' }),
      c.req.valid('param').id,
    );
    return c.json({ ok: true as const });
  },
);
register(
  usersRoutes,
  'users',
  {
    method: 'delete',
    auth: KEY,
    path: '/{id}/sessions/{sessionId}',
    summary: 'Revoke one session',
    params: IdParamSchema.extend({ sessionId: IdSchema }),
    response: OkSchema,
  },
  async (c) => {
    const sessionId = c.req.valid('param').sessionId;
    await revokeUserSession(
      serviceContext(c),
      platformActorOf(c, { scope: 'platform:users' }),
      c.req.valid('param').id,
      sessionId,
    );
    return c.json({ ok: true as const });
  },
);
