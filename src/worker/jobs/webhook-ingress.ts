import { type Grant, jobGrant } from '../platform/authority.ts';
import type { Check } from '../platform/authority-checks.ts';
import type { DenialOptions } from '../platform/errors.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';

declare const verified: unique symbol;
/** A connection whose inbound webhook signature was verified. Only `mintVerifiedWebhook` makes one. */
export interface VerifiedWebhook {
  readonly [verified]: true;
  readonly orgId: string;
  readonly connectionId: string;
}

const minted = new WeakSet<object>();
const KEY = Symbol('verified-webhook');

/** Called by the signature-verify step of `connections/webhooks.ts` and nothing else (import allowlist). */
export function mintVerifiedWebhook(connection: { orgId: string; id: string }): VerifiedWebhook {
  const token = Object.freeze({ orgId: connection.orgId, connectionId: connection.id });
  minted.add(token);
  return token as unknown as VerifiedWebhook;
}

/** The context carries the token to the staging writes it authorizes. */
export function withVerifiedWebhook(ctx: ServiceContext, token: VerifiedWebhook): ServiceContext {
  return { ...ctx, [KEY]: token } as ServiceContext;
}

export function verifiedWebhookOf(ctx: ServiceContext): VerifiedWebhook | undefined {
  const token = (ctx as unknown as Record<symbol, object | undefined>)[KEY];
  return token && minted.has(token) ? (token as unknown as VerifiedWebhook) : undefined;
}

const TABLES = [
  'connection_webhook_retention',
  'connection_webhook_items',
  'webhook_events',
  'connection_webhook_legacy_sources',
  'connection_inbox',
];

/**
 * The `system:` grant of a verified inbound webhook: fixed purpose, live, in the token's org, writing only
 * the webhook staging tables. The job context never leaves this function; `tools/authority-scope.ts`
 * allows only `connections/repo-grants.ts` to import it.
 */
export function webhookIngressGrant(
  ctx: ServiceContext,
  token: VerifiedWebhook,
  input: { checks?: Check[]; target?: string; codes?: DenialOptions['codes'] },
): Grant {
  if (!minted.has(token)) throw new Error('A verified webhook is required.');
  const job: ServiceContext = {
    ...createJobContext(ctx.env, 'connection-webhook', { clock: ctx.clock, log: ctx.log }),
    ids: ctx.ids,
    requestId: ctx.requestId,
    waitUntil: ctx.waitUntil,
  };
  return jobGrant(job, {
    job: 'connection-webhook',
    purpose: 'org_mode.job.connection.webhook_ingress',
    orgId: token.orgId,
    mode: 'live',
    tables: TABLES,
    ...(input.checks ? { checks: input.checks } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.codes ? { codes: input.codes } : {}),
  });
}
