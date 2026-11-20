import type { Context } from 'hono';
import {
  CursorQuerySchema,
  MyEmailListSchema,
  MySessionListSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { listMyEmails, listMySessions } from './service-account.ts';

type C = Context<AppBindings>;
type Router = ReturnType<typeof createRouter>;

export function registerMyEmailList(router: Router): void {
  register(
    router,
    'me',
    {
      method: 'get',
      path: '/emails',
      summary: 'My emails',
      query: CursorQuerySchema,
      response: MyEmailListSchema,
    },
    async (c: C) => c.json(await listMyEmails(serviceContext(c), currentUserId(c))),
  );
}

export function registerMySessionList(router: Router): void {
  register(
    router,
    'me',
    {
      method: 'get',
      path: '/sessions',
      summary: 'My sessions',
      query: CursorQuerySchema,
      response: MySessionListSchema,
    },
    async (c: C) =>
      c.json(
        await listMySessions(
          serviceContext(c),
          currentUserId(c),
          c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '',
        ),
      ),
  );
}
