import type { Context } from 'hono';
import {
  IdParamSchema,
  OkSchema,
  RemovePassStartedSchema,
  ResendResponseSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { ipPrefix, MAGIC_COOKIE, readCookie, setBindingCookie } from '../auth/cookies.ts';
import { MAGIC_TTL_MS } from '../auth/magic-service.ts';
import { lostMyPhone, resendMyPass, sendLostPhoneConfirmation } from './service-help.ts';

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
  register(
    router,
    'me',
    {
      method: 'post',
      path: '/passes/{id}/lost-phone/confirmation',
      summary: 'Email me a sign-in link that lands back on this pass, to confirm a lost phone',
      params: IdParamSchema,
      status: 202,
      response: OkSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      // As the sign-in request: only the 6-digit code is bound to this browser. The link works anywhere; the inbox is the proof.
      const existing = readCookie(c, MAGIC_COOKIE);
      const binding = existing && existing.length >= 32 ? existing : ctx.ids.token(32);
      setBindingCookie(c, MAGIC_COOKIE, binding, MAGIC_TTL_MS / 1000);
      return c.json(
        await sendLostPhoneConfirmation(
          ctx,
          currentUserId(c),
          c.req.valid('param').id,
          await sha256Hex(binding),
          ipPrefix(clientIp(c)),
        ),
        202,
      );
    },
  );
}
