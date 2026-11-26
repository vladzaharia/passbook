import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureHourFull } from './capture.ts';
import type { EndpointRow } from './repo-endpoints.ts';
import { hostOf } from './url.ts';

/**
 * Whether a send may go now. One destination host takes a bounded number of sends a minute, across every
 * org and lane; over the limit the delivery waits, and neither the attempt nor the endpoint is charged.
 * A sandbox URL endpoint also draws on its sandbox's own limit. A capture endpoint has no host: it waits only when its org has used the hour's captures.
 */
export async function sendAllowed(
  ctx: ServiceContext,
  endpoint: EndpointRow,
  sandbox: boolean,
): Promise<boolean> {
  if (endpoint.target === 'capture') return !(await captureHourFull(ctx, endpoint.orgId));
  const host = hostOf(endpoint.url);
  try {
    // A sandbox's own 60 a minute comes first, so its backlog never spends the host's budget.
    if (
      endpoint.mode === 'test' &&
      sandbox &&
      !(await checkRateLimit(ctx.env, 'RL_SANDBOX_DELIVERY', `org:${endpoint.orgId}`))
    )
      return false;
    // The org's own share first, so a tenant over it never spends the host's global budget.
    return (
      (await checkRateLimit(ctx.env, 'RL_WEBHOOK_HOST_ORG', `host:${host}:${endpoint.orgId}`)) &&
      (await checkRateLimit(ctx.env, 'RL_WEBHOOK_HOST', `host:${host}`))
    );
  } catch {
    ctx.log.error('webhooks.rate_limit_unavailable', {
      orgId: endpoint.orgId,
      endpointId: endpoint.id,
      code: 'RATE_LIMIT_UNAVAILABLE',
    });
    return false;
  }
}
