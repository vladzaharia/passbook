import { IdParamSchema, OkSchema, ResendEmailSchema } from '../../../shared/contracts/index.ts';
import { BadRequestError, ConflictError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { resendEmail } from './pass-service-delivery.ts';
import { claimIdempotencyKey, getIdempotencyKey, releaseIdempotencyKey } from './repo-ops.ts';

/** Holder email actions. */
export function registerActionRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
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
      const raw = c.req.header('idempotency-key')?.trim();
      if (raw === undefined) {
        await resendEmail(ctx, actorFor(c), id, body, scope, authority);
        return c.json({ ok: true as const }, 202);
      }
      if (raw.length < 1 || raw.length > 200)
        throw new BadRequestError(
          'Idempotency-Key must be 1 to 200 characters.',
          'IDEMPOTENCY_KEY_INVALID',
        );
      const key = `resend:${id}:${raw}`;
      const hash = await sha256Hex(JSON.stringify([id, body.to ?? null, body.attach ?? false]));
      const replay = async () => {
        const existing = await getIdempotencyKey(ctx.env.DB, pass.orgId, key);
        if (!existing)
          throw new ConflictError('The pass or authorization changed. Retry.', 'PASS_CONFLICT');
        if (existing.requestHash !== hash)
          throw new ConflictError(
            'This Idempotency-Key was used for a different request.',
            'IDEMPOTENCY_KEY_REUSED',
          );
        return c.json({ ok: true as const }, 202);
      };
      if (await getIdempotencyKey(ctx.env.DB, pass.orgId, key)) return replay();
      const reservation = ctx.ids.id();
      if (
        !(await claimIdempotencyKey(
          ctx.env.DB,
          pass.orgId,
          key,
          hash,
          reservation,
          ctx.clock.now(),
          authority,
        ))
      )
        return replay();
      try {
        await resendEmail(ctx, actorFor(c), id, body, scope, authority);
      } catch (error) {
        await releaseIdempotencyKey(ctx.env.DB, pass.orgId, key, reservation, hash);
        throw error;
      }
      return c.json({ ok: true as const }, 202);
    },
  );
}
