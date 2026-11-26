import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor } from '../audit/service.ts';
import { platformEnvMismatch } from './db-resolver.ts';
import { PLATFORM_IDENTITY_ID, readEnvIdentity } from './env-identity.ts';
import { getDefaultRow, getIdentityRow, type IdentityRow } from './repo.ts';
import { registeredDeviceCount, switchDefault } from './repo-platform-default.ts';

const notReady = (message: string) => new ConflictError(message, 'IDENTITY_NOT_READY');

/** Why the legacy row cannot take the default back: its env material must still sign. */
function assertLegacyReady(ctx: ServiceContext, row: IdentityRow): void {
  try {
    if (!platformEnvMismatch(readEnvIdentity(ctx.env), row)) return;
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  throw notReady('The legacy platform identity is not configured. It cannot be the default.');
}

/** Health and the owner's device test, then the flip. Every check runs before anything is written. */
async function assertReady(ctx: ServiceContext, row: IdentityRow): Promise<void> {
  const now = ctx.clock.now();
  if (row.id === PLATFORM_IDENTITY_ID) assertLegacyReady(ctx, row);
  else {
    if (row.org_id !== null || row.purpose !== 'passes')
      throw notReady('Only a platform passes identity can be the default.');
    if (row.issuing !== 1) throw notReady('The identity is not issuing. Set it up first.');
  }
  if (row.cert_pem === null || (row.not_after !== null && row.not_after <= now))
    throw notReady('The identity has no active certificate.');
  if (row.id === PLATFORM_IDENTITY_ID) return;
  if (row.apns_health !== 'healthy') throw notReady('Push is not healthy. Run the push check.');
  if ((await registeredDeviceCount(ctx.env.DB, row.id)) === 0)
    throw notReady('No device has registered a pass on this identity. Run the device test first.');
}

/**
 * Makes `identityId` the platform default (design 3.3). The new identity needs an active certificate,
 * issuing on, a healthy push and a device that registered one of its passes. The legacy `platform`
 * row then stops issuing but keeps signing and pushing for passes already issued. Targeting
 * `platform` reverses the flip. A repeat call changes nothing.
 */
export async function setPlatformDefault(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
): Promise<{ changed: boolean }> {
  const row = await getIdentityRow(ctx.env.DB, identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (row.is_default === 1) return { changed: false };
  await assertReady(ctx, row);
  const previous = await getDefaultRow(ctx.env.DB);
  const moved = await switchDefault(ctx.env.DB, ctx, row, ctx.clock.now(), {
    ...auditActor(actor),
    orgId: null,
    action: 'identity.platform_default_changed',
    targetType: 'identity',
    targetId: row.id,
    detail: { from: previous?.id ?? null, passTypeIdentifier: row.pass_type_identifier },
  });
  if (!moved) throw notReady('The identity stopped being ready. Check it and try again.');
  ctx.log.info('identity.platform_default_changed', { identityId: row.id });
  return { changed: true };
}
