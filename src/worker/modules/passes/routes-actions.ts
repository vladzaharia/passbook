import { IdParamSchema, OkSchema, ResendEmailSchema } from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { newPassCode } from './new-code.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { resendEmail } from './pass-service-delivery.ts';

/** Holder email actions. */
export function registerActionRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/new-code',
      summary: 'Mint a new scan code; the old code stops working',
      params: IdParamSchema,
      response: OkSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      await newPassCode(ctx, actorFor(c), id, scope, authority);
      return c.json({ ok: true as const });
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/resend-email',
      summary: 'Email the pass to the holder (Idempotency-Key supported)',
      params: IdParamSchema,
      body: ResendEmailSchema,
      status: 202,
      response: OkSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const body = c.req.valid('json');
      const auth = authOf(c);
      const { scope, pass, authority } = await tenantPassForWrite(ctx, auth, id, passScopeOf(c));
      const run = async () => {
        await resendEmail(ctx, actorFor(c), id, body, scope, authority);
        return { ok: true as const };
      };
      return idempotentJson(
        c,
        ctx,
        {
          orgId: pass.orgId,
          mode: modeOf(auth),
          principal: principalOf(auth),
          body: { id, ...body },
        },
        202,
        run,
      );
    },
  );
}
