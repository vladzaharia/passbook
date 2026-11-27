import { assertCanSign } from '../../../passkit/index.ts';
import { DEVICE_PASS_UNAVAILABLE_COPY } from '../../../shared/copy/workbench-device-pass.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ResolvedIdentity } from '../identities/env-identity.ts';
import { PLATFORM_SLOTS } from '../identities/provision-platform.ts';
import { findByPassType, getIdentityRow } from '../identities/repo.ts';
import { depsOf } from '../passes/deps.ts';

/** Off unless the owner has turned device passes on (`DEVICE_PASS_ENABLED` is "1"). Off is also the kill switch. */
export const devicePassEnabled = (env: { DEVICE_PASS_ENABLED?: string }): boolean =>
  env.DEVICE_PASS_ENABLED === '1';

const unavailable = () =>
  new UnavailableError(DEVICE_PASS_UNAVAILABLE_COPY, 'DEVICE_PASS_IDENTITY_NOT_READY');

/**
 * The dedicated device-test identity (`pass.mobile.passbook.devtest`) and nothing else: there is no fallback to the
 * platform identity, so an unset or lapsed identity stops device passes and touches no other pass.
 * The certificate is checked with `assertCanSign` before anything is made; `signPass` checks it again.
 * @absorbs Every resolver or certificate refusal is logged and answered as `DEVICE_PASS_IDENTITY_NOT_READY`.
 */
export async function deviceTestIdentity(ctx: ServiceContext): Promise<ResolvedIdentity> {
  const db = ctx.env.DB;
  const found = await findByPassType(db, PLATFORM_SLOTS.devtest.passType);
  const row = found ? await getIdentityRow(db, found.id) : null;
  if (row?.purpose !== 'device_test' || row.org_id !== null || row.issuing !== 1)
    throw unavailable();
  try {
    const identity = await depsOf(ctx.env).identities.byId(row.id);
    await assertCanSign(identity.material, {
      now: new Date(ctx.clock.now()),
      expectedIdentity: {
        passTypeIdentifier: identity.passTypeIdentifier,
        teamIdentifier: identity.teamIdentifier,
      },
    });
    return identity;
  } catch (error) {
    const code = error instanceof AppError ? error.code : (error as { code?: string }).code;
    ctx.log.error('device_pass.identity_unusable', {
      code: 'DEVICE_PASS_IDENTITY_NOT_READY',
      cause: code,
    });
    throw unavailable();
  }
}
