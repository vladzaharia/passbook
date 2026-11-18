import type { Actor } from '../../platform/context.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import { createSafeFetch, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WebhookAccess } from './access.ts';
import { SEND_TIMEOUT_MS } from './deliver.ts';
import { bodyOf, testEnvelope } from './payload.ts';
import { insertTestAttempt } from './repo-api.ts';
import { activeSecrets } from './repo-secrets.ts';
import { memoResolver } from './resolver-memo.ts';
import { openSecret } from './secrets.ts';
import { commitEndpoint, requireEndpoint, webhookGrant } from './service.ts';
import { requestHeaders } from './sign.ts';

export interface TestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  errorCode: string | null;
}

async function secretsOf(
  ctx: ServiceContext,
  ring: KekRing,
  access: WebhookAccess,
  endpoint: { id: string },
) {
  const { orgId, mode } = access.authority;
  const rows = await activeSecrets(ctx.env.DB, { orgId, mode }, endpoint.id, ctx.clock.now());
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(
        await openSecret(ring, row.envelope, {
          secretId: row.id,
          orgId,
          endpointId: endpoint.id,
          mode,
        }),
      );
    } catch {
      ctx.log.error('webhooks.secret_unavailable', {
        orgId,
        endpointId: endpoint.id,
        code: 'SECRET_UNAVAILABLE',
      });
    }
  }
  return out;
}

/**
 * "Send test": one signed `webhook.test` POST to this endpoint only, in the endpoint's own mode. It
 * describes no pass, writes no feed row or delivery, and leaves the endpoint's health counters alone;
 * the attempt is logged (event_seq NULL, kept 7 days). Ten a minute per endpoint.
 */
export async function sendTest(
  ctx: ServiceContext,
  _actor: Actor,
  access: WebhookAccess,
  endpointId: string,
): Promise<TestResult> {
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  // Per tenant, so recreating endpoints does not reset it; and the destination host's global budget is charged.
  const { orgId, mode } = access.authority;
  if (!(await checkRateLimit(ctx.env, 'RL_WEBHOOK_OUT', `test:${orgId}:${mode}`)))
    throw new RateLimitedError();
  if (
    !(await checkRateLimit(
      ctx.env,
      'RL_WEBHOOK_HOST',
      `host:${new URL(endpoint.url).host.toLowerCase()}`,
    ))
  )
    throw new RateLimitedError();
  const secrets = await secretsOf(ctx, await loadKekRing(ctx.env), access, endpoint);
  const startedAt = ctx.clock.now();
  const event = testEnvelope({
    id: ctx.ids.id(),
    orgId: endpoint.orgId,
    mode: endpoint.mode,
    now: startedAt,
    apiVersion: endpoint.apiVersion,
  });
  const body = bodyOf(event);
  let status: number | null = null;
  let errorCode: string | null = null;
  if (secrets.length === 0) {
    errorCode = 'SECRET_UNAVAILABLE';
  } else {
    const send = createSafeFetch({
      platformHosts: platformHostsOf(ctx.env),
      timeoutMs: SEND_TIMEOUT_MS,
      discardBody: true,
      resolver: memoResolver(() => ctx.clock.now()),
    });
    try {
      const res = await send(endpoint.url, {
        method: 'POST',
        headers: await requestHeaders({
          eventId: event.id,
          eventType: event.type,
          secrets,
          nowMs: startedAt,
          body,
        }),
        body,
      });
      status = res.status;
    } catch (e) {
      errorCode =
        e instanceof AppError && /^[A-Z][A-Z0-9_]{1,39}$/.test(e.code) ? e.code : 'UPSTREAM';
    }
  }
  const durationMs = Math.max(0, ctx.clock.now() - startedAt);
  const g = webhookGrant(ctx, access, 'test');
  insertTestAttempt(g, {
    id: ctx.ids.id(),
    endpointId,
    status,
    errorCode,
    durationMs,
    at: startedAt,
  });
  await commitEndpoint(g);
  return { ok: status !== null && status >= 200 && status < 300, status, durationMs, errorCode };
}
