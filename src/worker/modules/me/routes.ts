import type { Context } from 'hono';
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
import { currentUserId, requireSession } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { clearSessionCookie } from '../auth/cookies.ts';
import {
  addMyEmail,
  getMyPass,
  listMyEmails,
  listMyPasses,
  listMySessions,
  refreshMyPass,
  removeMyEmail,
  removeMyPass,
  revokeAllMySessions,
  revokeMySession,
} from './service.ts';

type C = Context<AppBindings>;
const id = (c: C) => c.req.param('id') ?? '';
const sessionId = (c: C) => (c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '');

export const meRoutes = createRouter();
guard(meRoutes, requireSession);

register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes',
    summary: 'My passes',
    query: PageQuerySchema,
    response: MyPassListSchema,
  },
  async (c: C) =>
    c.json(
      await listMyPasses(serviceContext(c), currentUserId(c), PageQuerySchema.parse(c.req.query())),
    ),
);
register(
  meRoutes,
  'me',
  {
    method: 'get',
    path: '/passes/{id}',
    summary: 'One of my passes',
    params: IdParamSchema,
    response: MyPassSchema,
  },
  async (c: C) => c.json(await getMyPass(serviceContext(c), currentUserId(c), id(c))),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/passes/{id}/refresh',
    summary: 'Force refresh (3/min per pass)',
    params: IdParamSchema,
    status: 202,
    response: RefreshResponseSchema,
  },
  async (c: C) => c.json(await refreshMyPass(serviceContext(c), currentUserId(c), id(c)), 202),
);
register(
  meRoutes,
  'me',
  {
    method: 'delete',
    path: '/passes/{id}',
    summary: 'Remove from my passes (blocks re-attach)',
    params: IdParamSchema,
    response: RemovePassResponseSchema,
  },
  async (c: C) => c.json(await removeMyPass(serviceContext(c), currentUserId(c), id(c))),
);
register(
  meRoutes,
  'me',
  { method: 'get', path: '/emails', summary: 'My emails', response: MyEmailListSchema },
  async (c: C) => c.json(await listMyEmails(serviceContext(c), currentUserId(c))),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/emails',
    summary: 'Add an email and send a verification link',
    body: AddEmailRequestSchema,
    status: 202,
    response: OkSchema,
  },
  async (c: C) => {
    const { email } = AddEmailRequestSchema.parse(await c.req.json());
    return c.json(await addMyEmail(serviceContext(c), currentUserId(c), email), 202);
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'delete',
    path: '/emails/{email}',
    summary: 'Remove an email',
    params: z.object({ email: z.string() }),
    response: MyEmailListSchema,
  },
  async (c: C) =>
    c.json(await removeMyEmail(serviceContext(c), currentUserId(c), c.req.param('email') ?? '')),
);
register(
  meRoutes,
  'me',
  { method: 'get', path: '/sessions', summary: 'My sessions', response: MySessionListSchema },
  async (c: C) => c.json(await listMySessions(serviceContext(c), currentUserId(c), sessionId(c))),
);
register(
  meRoutes,
  'me',
  {
    method: 'post',
    path: '/sessions/revoke-all',
    summary: 'Sign out everywhere',
    response: OkSchema,
  },
  async (c: C) => {
    const result = await revokeAllMySessions(serviceContext(c), currentUserId(c));
    clearSessionCookie(c);
    return c.json(result);
  },
);
register(
  meRoutes,
  'me',
  {
    method: 'delete',
    path: '/sessions/{id}',
    summary: 'Revoke one of my sessions',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: C) => {
    const result = await revokeMySession(serviceContext(c), currentUserId(c), id(c));
    if (id(c) === sessionId(c)) clearSessionCookie(c);
    return c.json(result);
  },
);
