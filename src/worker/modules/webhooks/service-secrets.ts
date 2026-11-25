import type { Actor } from '../../platform/context.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WebhookAccess } from './access.ts';
import { rotateSecret } from './repo-secrets.ts';
import { newEndpointSecret, sealSecret } from './secrets.ts';
import { auditEndpoint, commitEndpoint, requireEndpoint, webhookGrant } from './service.ts';
import { hostOf } from './url.ts';

const HOUR = 3_600_000;

/**
 * A new current secret, shown once. The old one signs alongside it for `overlapHours` (0, 1, 24, 72 or 168);
 * an older expiring one is cut to now. A foreign or just-deleted endpoint aborts the batch, so no
 * secret that was never stored is returned.
 */
export async function rotate(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  endpointId: string,
  overlapHours: number,
): Promise<{ secret: string }> {
  const { orgId, mode } = access.authority;
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  const secretId = ctx.ids.id();
  const secret = newEndpointSecret(ctx);
  const now = ctx.clock.now();
  const envelope = await sealSecret(await loadKekRing(ctx.env), secret, {
    secretId,
    orgId,
    endpointId,
    mode,
  });
  const g = webhookGrant(ctx, access, 'secret.rotate');
  rotateSecret(g, { id: secretId, endpointId, envelope, now, overlapMs: overlapHours * HOUR });
  auditEndpoint(ctx, g, actor, access, 'webhook.secret.rotate', endpointId, {
    host: hostOf(endpoint.url),
    overlapHours,
  });
  await commitEndpoint(g);
  return { secret };
}
