import type { Context } from 'hono';
import {
  IdParamSchema,
  RemovePassStartedSchema,
  ResendResponseSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { lostMyPhone, resendMyPass } from './service-help.ts';

type C = Context<AppBindings>;
type Router = ReturnType<typeof createRouter>;
const sessionId = (c: C) => (c.var.auth?.kind === 'session' ? c.var.auth.sessionId : '');

/** Send it again, and I lost my phone: both start an operation the holder follows. */
export function registerMyPassHelp(router: Router): void {
  register(
    router,
    'me',
    {
      method: 'post',
      path: '/passes/{id}/resend',
      summary: 'Email my pass to me again',
      params: IdParamSchema,
      status: 202,
      response: ResendResponseSchema,
    },
    async (c) =>
      c.json(
        await resendMyPass(
          serviceContext(c),
          currentUserId(c),
          sessionId(c),
          c.req.valid('param').id,
        ),
        202,
      ),
  );
  register(
    router,
    'me',
    {
      method: 'post',
      path: '/passes/{id}/lost-phone',
      summary: 'Replace my pass code and link, and email it to me',
      params: IdParamSchema,
      status: 202,
      response: RemovePassStartedSchema,
    },
    async (c) =>
      c.json(
        await lostMyPhone(
          serviceContext(c),
          currentUserId(c),
          sessionId(c),
          c.req.valid('param').id,
        ),
        202,
      ),
  );
}
