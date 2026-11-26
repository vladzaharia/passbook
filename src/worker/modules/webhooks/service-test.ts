import type { WebhookEventType } from '../../../shared/contracts/webhooks.ts';
import type { Actor } from '../../platform/context.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { AppError, ConflictError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import { createSafeFetch, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fenceOf, type WebhookAccess } from './access.ts';
import { openActiveSecrets } from './capture.ts';
import { SEND_TIMEOUT_MS } from './deliver.ts';
import { sendAllowed } from './deliver-gate.ts';
import { bodyOf, buildEnvelope, testEnvelope } from './payload.ts';
import { insertTestAttempt, listTestAttempts } from './repo-api.ts';
import { resolverFor } from './resolver-memo.ts';
import { sampleRow } from './sample-events.ts';
import { commitEndpoint, requireEndpoint, webhookGrant } from './service.ts';
import { storeCapture } from './service-captures.ts';
import { requestHeaders } from './sign.ts';

export interface TestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  errorCode: string | null;
  /** The stored capture, for a capture endpoint. */
  captureId: string | null;
}

/**
 * "Send test": one signed event to this endpoint only, in the endpoint's own mode: `webhook.test`, or a
 * sample of any other type (Test endpoints only, since a Live receiver would take it for a real event). It
 * describes no real pass, writes no feed row or delivery, and leaves the endpoint's health counters alone;
 * the attempt is logged (event_seq NULL, kept 7 days). A capture endpoint stores the signed request and
 * sends nothing. Ten a minute per tenant.
 */
export async function sendTest(
  ctx: ServiceContext,
  _actor: Actor,
  access: WebhookAccess,
  endpointId: string,
  type: WebhookEventType = 'webhook.test',
): Promise<TestResult> {
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  if (type !== 'webhook.test' && endpoint.mode !== 'test')
    throw new ConflictError('Sample events go to Test endpoints only.', 'SAMPLE_EVENT_LIVE');
  // Per tenant, so recreating endpoints does not reset it; and the destination host's global budget is charged.
  const { orgId, mode } = access.authority;
  if (!(await checkRateLimit(ctx.env, 'RL_WEBHOOK_OUT', `test:${orgId}:${mode}`)))
    throw new RateLimitedError();
  // The host budgets a delivery spends; a sandbox's own limit is not spent here, the test-send limit above covers it.
  if (!(await sendAllowed(ctx, endpoint, false))) throw new RateLimitedError();
  const secrets = await openActiveSecrets(ctx, await loadKekRing(ctx.env), endpoint);
  const startedAt = ctx.clock.now();
  const id = ctx.ids.id();
  const event =
    type === 'webhook.test'
      ? testEnvelope({
          id,
          orgId: endpoint.orgId,
          mode: endpoint.mode,
          now: startedAt,
          apiVersion: endpoint.apiVersion,
        })
      : buildEnvelope(
          sampleRow(type, {
            eventId: id,
            orgId: endpoint.orgId,
            mode: endpoint.mode,
            now: startedAt,
          }),
          endpoint.apiVersion,
          true,
        );
  let status: number | null = null;
  let errorCode: string | null = null;
  let captureId: string | null = null;
  if (secrets.length === 0) {
    errorCode = 'SECRET_UNAVAILABLE';
  } else if (endpoint.target === 'capture') {
    const input = {
      eventId: event.id,
      eventType: event.type,
      body: bodyOf(event),
      trigger: 'test',
      secrets,
      now: startedAt,
    } as const;
    captureId = (await storeCapture(ctx, access, endpoint, input)).id;
    status = 200;
  } else {
    const body = bodyOf(event);
    const send = createSafeFetch({
      platformHosts: platformHostsOf(ctx.env),
      timeoutMs: SEND_TIMEOUT_MS,
      discardBody: true,
      resolver: resolverFor(ctx.env, () => ctx.clock.now()),
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
    id: event.id,
    endpointId,
    type,
    status,
    errorCode,
    durationMs,
    at: startedAt,
  });
  await commitEndpoint(g);
  return {
    ok: status !== null && status >= 200 && status < 300,
    status,
    durationMs,
    errorCode,
    captureId,
  };
}

const TEST_LIST_LIMIT = 20;

/** The endpoint's recent test sends, newest first, for the deliveries view. */
export async function listTests(ctx: ServiceContext, access: WebhookAccess, endpointId: string) {
  await requireEndpoint(ctx, access, endpointId);
  const rows = await listTestAttempts(ctx.env.DB, fenceOf(access), endpointId, TEST_LIST_LIMIT);
  return {
    items: rows.map((r) => ({
      ...r,
      ok: r.status !== null && r.status >= 200 && r.status < 300,
    })),
  };
}
