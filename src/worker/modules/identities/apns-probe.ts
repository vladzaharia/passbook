import type { ApnsProbeResult } from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { createMtlsApnsTransport } from '../delivery/apns.ts';
import { apnsBindingPresent } from './db-resolver.ts';
import { getIdentityRow, type IdentityRow, listIdentityRows, setProbeHealth } from './repo.ts';

const DUMMY_TOKEN = '0'.repeat(64);
const ACCEPTED = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);
const REJECTED = new Set([
  'BadCertificate',
  'BadCertificateEnvironment',
  'TopicDisallowed',
  'MissingTopic',
  'Forbidden',
  'ExpiredProviderToken',
]);

export function interpretProbe(
  status: number,
  reason: string | undefined,
): 'healthy' | 'failing' | 'inconclusive' {
  if (status === 400 && reason && ACCEPTED.has(reason)) return 'healthy';
  if (status === 0 || status === 403 || (reason && REJECTED.has(reason))) return 'failing';
  return 'inconclusive';
}

/** One request to APNs with a dummy token: proves mTLS and topic without touching any device. */
export async function probeRow(
  ctx: ServiceContext,
  row: IdentityRow,
  actor: Actor | null,
): Promise<ApnsProbeResult> {
  const now = ctx.clock.now();
  const done = (
    health: ApnsProbeResult['health'],
    status: number,
    reason?: string,
  ): ApnsProbeResult => ({ health, status, reason: reason ?? null, checkedAt: now });
  let result: ApnsProbeResult;
  if (!apnsBindingPresent(ctx.env, row.apns_binding)) {
    result = done('unavailable', 0, 'PushUnavailable');
  } else {
    const transport = createMtlsApnsTransport(ctx.env);
    const [sent] = await transport.send(
      { passTypeIdentifier: row.pass_type_identifier, apnsBinding: row.apns_binding },
      [DUMMY_TOKEN],
      now,
    );
    const status = sent?.status ?? 0;
    result = done(interpretProbe(status, sent?.reason), status, sent?.reason);
  }
  if (result.health === 'healthy' || result.health === 'failing')
    await setProbeHealth(ctx.env.DB, row.id, result.health);
  ctx.log.info('identities.apns_probe', {
    identityId: row.id,
    health: result.health,
    status: result.status,
    code: result.reason ?? 'ok',
  });
  await recordAudit(ctx, {
    ...(actor ? auditActor(actor) : { actorType: 'system' as const }),
    orgId: row.org_id,
    action: 'identity.apns_probe',
    targetType: 'identity',
    targetId: row.id,
    detail: { health: result.health, status: result.status, reason: result.reason },
  });
  return result;
}

export async function probeApns(
  ctx: ServiceContext,
  actor: Actor | null,
  identityId: string,
): Promise<ApnsProbeResult> {
  const row = await getIdentityRow(ctx.env.DB, identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  return probeRow(ctx, row, actor);
}

/** Daily: probe every identity that names a binding the deployment has. */
export async function runDailyApnsProbes(ctx: ServiceContext): Promise<void> {
  for (const row of await listIdentityRows(ctx.env.DB)) {
    if (!apnsBindingPresent(ctx.env, row.apns_binding)) continue;
    try {
      await probeRow(ctx, row, null);
    } catch (error) {
      ctx.log.warn('identities.apns_probe_failed', {
        identityId: row.id,
        code: 'PROBE_ERROR',
        error,
      });
    }
  }
}
