import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getUser } from '../users/repo.ts';
import { ADMIN_SETTINGS } from './actor.ts';
import { assertAdminConfigurationAuthority } from './repo-scanner-configuration-authority.ts';
import { adminSetupId } from './repo-setups.ts';
import { loadScanner } from './scanner-views.ts';
import { createSetup } from './setups.ts';

export async function startAdminSetup(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: { orgId: string; timeZone: string },
  origin: string,
  authority: TenantPassWrite,
) {
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  let id = await adminSetupId(ctx.env.DB, input.orgId, mode, userId);
  if (!id) {
    const user = await getUser(ctx.env.DB, userId);
    try {
      const made = await createSetup(
        ctx,
        userId,
        mode,
        {
          ...input,
          name: `Admin ${user?.name ?? userId}`.slice(0, 40),
          kind: 'device',
          deviceRole: 'scan',
          adminUserId: userId,
          accepts: null,
          settings: { ...ADMIN_SETTINGS, flow: 'auto', reader: 'none' },
        },
        origin,
        authority,
      );
      id = made.id;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      id = await adminSetupId(ctx.env.DB, input.orgId, mode, userId);
      if (!id) throw error;
    }
  }
  await assertAdminConfigurationAuthority(ctx.env.DB, input.orgId, {
    kind: 'admin',
    userId,
    authority,
    now: ctx.clock.now(),
  });
  const row = await loadScanner(ctx, id);
  return { setupId: id, orgId: row.orgId, mode: row.mode, timeZone: row.timeZone };
}
