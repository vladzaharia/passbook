import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor } from '../audit/service.ts';
import { PLATFORM_IDENTITY_ID } from './env-identity.ts';
import { legacyConfigured, platformReadiness } from './platform-readiness.ts';
import { getDefaultRow, getIdentityRow, type IdentityRow } from './repo.ts';
import { switchDefault } from './repo-platform-default.ts';

const notReady = (message: string) => new ConflictError(message, 'IDENTITY_NOT_READY');

/** The first check that fails, in the order the owner reads them; the list reports the same facts. */
async function assertReady(ctx: ServiceContext, row: IdentityRow): Promise<void> {
  const ready = await platformReadiness(ctx, row);
  if (row.id === PLATFORM_IDENTITY_ID) {
    if (!legacyConfigured(ctx, row))
      throw notReady('The legacy platform identity is not configured. It cannot be the default.');
  } else {
    if (!ready.eligible) throw notReady('Only a platform passes identity can be the default.');
    if (!ready.issuing) throw notReady('The identity is not issuing. Set it up first.');
  }
  if (!ready.certificate) throw notReady('The identity has no active certificate.');
  if (row.id === PLATFORM_IDENTITY_ID) return;
  if (!ready.pushHealthy) throw notReady('Push is not healthy. Run the push check.');
  if (!ready.pushProbeFresh)
    throw notReady('Push was not checked in the last 24 hours. Run the push check.');
  if (!ready.deviceTest)
    throw notReady(
      'No device has registered a pass of this identity from a personal org. Run the device test first.',
    );
}

/**
 * Makes `identityId` the platform default (design 3.3). The new identity needs an active certificate,
 * issuing on, a healthy push checked within a day and a platform admin's device that registered one of its
 * passes from their personal org. The legacy `platform`
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
