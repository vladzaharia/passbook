import type { PlatformCaller } from '../../platform/actor.ts';
import type { Actor } from '../../platform/context.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgRow } from './repo.ts';
import { personalOrgIdOf } from './repo-personal.ts';
import { setOrgStatus } from './service.ts';

/** A disabled user's personal org stops with them: suspended, with the admin who disabled them on the audit row. */
export async function suspendPersonalOrgOf(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  admin: PlatformCaller,
): Promise<void> {
  const org = await personalOrgIdOf(ctx.env.DB, userId);
  const row = org && (await getOrgRow(ctx.env.DB, org.id));
  if (row && row.status === 'active') await setOrgStatus(ctx, actor, row.id, 'suspended', admin);
}
