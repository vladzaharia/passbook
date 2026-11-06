import type { Mode } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScanActor, scannerActor } from './actor.ts';
import { getScanner, touchScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { setupMeta } from './repo-setups.ts';

export async function managedAdminActor(
  ctx: ServiceContext,
  session: SessionAuth,
  mode: Mode,
  orgId: string,
  setupId: string,
): Promise<ScanActor> {
  const [row, meta] = await Promise.all([
    getScanner(ctx.env.DB, setupId),
    setupMeta(ctx.env.DB, orgId, setupId),
  ]);
  if (
    !row ||
    row.orgId !== orgId ||
    row.mode !== mode ||
    row.revokedAt !== null ||
    !meta?.admin_session ||
    meta.admin_user_id !== session.userId
  )
    throw new ForbiddenError('Choose your admin scanner setup.', 'SCAN_ADMIN_SETUP_REQUIRED');
  const scope = await readScannerScope(ctx.env.DB, row, null);
  await touchScanner(ctx.env.DB, row.id, ctx.clock.now(), null, 60_000);
  const actor = scannerActor(ctx, row, mode, 'cookie', scope);
  return {
    ...actor,
    principal: 'admin',
    actorKey: `u:${session.userId}:${row.id}`,
    actor: { type: 'user', id: session.userId },
    role: 'manager',
    staff: null,
  };
}
