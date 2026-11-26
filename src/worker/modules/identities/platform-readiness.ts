import type { PlatformReadiness } from '../../../shared/contracts/identities.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { platformEnvMismatch } from './db-resolver.ts';
import { PLATFORM_IDENTITY_ID, readEnvIdentity } from './env-identity.ts';
import { type IdentityRow, identityFacts } from './repo.ts';
import { deviceTestPassed, PROBE_FRESH_MS } from './repo-platform-default.ts';

/** The legacy row can take the default only while its env material still signs. */
export function legacyConfigured(ctx: ServiceContext, row: IdentityRow): boolean {
  try {
    return !platformEnvMismatch(readEnvIdentity(ctx.env), row);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return false;
  }
}

/**
 * What `setPlatformDefault` checks, as facts. The default switch refuses on the first one that is
 * false, and the platform list reports the same object, so the two cannot drift. A check the row is
 * not held to (the legacy row skips push and the device test) is `null`.
 */
export async function platformReadiness(
  ctx: ServiceContext,
  row: IdentityRow,
): Promise<PlatformReadiness> {
  const now = ctx.clock.now();
  const legacy = row.id === PLATFORM_IDENTITY_ID;
  const live = row.cert_pem !== null && (row.not_after === null || row.not_after > now);
  if (legacy) {
    const certificate = legacyConfigured(ctx, row) && live;
    return {
      eligible: true,
      certificate,
      issuing: null,
      pushHealthy: null,
      pushProbeAt: null,
      pushProbeFresh: null,
      deviceTest: null,
      ready: certificate,
    };
  }
  const eligible = row.org_id === null && row.purpose === 'passes';
  const probedAt = (await identityFacts(ctx.env.DB, row.id)).checked_at;
  const pushProbeFresh = probedAt !== null && probedAt >= now - PROBE_FRESH_MS;
  const deviceTest = await deviceTestPassed(ctx.env.DB, row.id);
  const issuing = row.issuing === 1;
  const pushHealthy = row.apns_health === 'healthy';
  return {
    eligible,
    certificate: live,
    issuing,
    pushHealthy,
    pushProbeAt: probedAt,
    pushProbeFresh,
    deviceTest,
    ready: eligible && live && issuing && pushHealthy && pushProbeFresh && deviceTest,
  };
}
