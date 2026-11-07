import type { Mode } from '../../../shared/contracts/common.ts';
import { parseRoles } from '../../platform/json-column.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getSession } from '../auth/repo-sessions.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { setupMeta, watchOf } from './repo-setups.ts';
import { bindScanningSession, sessionScreenWatch } from './scanning-workspace.ts';

export interface LiveAttachment {
  orgId: string;
  mode: Mode;
  scannerId: string;
  role: 'customer' | 'monitor';
  tokenHash: string;
  revision: number;
  expiresAt: number;
  admin?: { sessionId: string; userId: string };
}

/** Read authoritative rows before each delivery; a cached socket never extends a credential. */
export async function liveRecipient(ctx: ServiceContext, a: LiveAttachment) {
  const now = ctx.clock.now();
  if (a.expiresAt <= now) return null;
  const [row, meta, active, parent, adminSession] = await Promise.all([
    getScanner(ctx.env.DB, a.scannerId),
    setupMeta(ctx.env.DB, a.orgId, a.scannerId),
    orgIsActive(ctx.env.DB, a.orgId),
    scanningSessionForDevice(ctx.env.DB, a.orgId, a.scannerId),
    a.admin ? getSession(ctx.env.DB, a.admin.sessionId) : Promise.resolve(null),
  ]);
  if (
    !row ||
    !active ||
    row.orgId !== a.orgId ||
    row.mode !== a.mode ||
    row.deviceRole !== a.role ||
    row.revokedAt !== null ||
    (a.admin
      ? !adminSession ||
        adminSession.revoked_at !== null ||
        adminSession.user_status !== 'active' ||
        adminSession.user_id !== a.admin.userId ||
        meta?.admin_user_id !== a.admin.userId ||
        adminSession.expires_at <= now ||
        adminSession.idle_expires_at <= now ||
        !parseRoles(adminSession.roles).includes('admin')
      : row.tokenHash !== a.tokenHash) ||
    row.updatedAt !== a.revision ||
    (!a.admin && (row.expiresAt === null || row.expiresAt <= now)) ||
    (parent !== null && (parent.status !== 'active' || parent.mode !== a.mode))
  )
    return null;
  const watch = (await sessionScreenWatch(ctx, a.orgId, a.scannerId)) ?? watchOf(meta);
  if (!watch || (a.role === 'customer' && watch.allOrg)) return null;
  const actor = withRole(
    scannerActor(ctx, row, row.mode, 'cookie', { event: null, templateIds: [] }),
    null,
  );
  await bindScanningSession(ctx, actor);
  if (a.admin) {
    actor.principal = 'admin';
    actor.actor = { type: 'user', id: a.admin.userId };
    actor.actorKey = `u:${a.admin.userId}:${row.id}`;
    actor.role = 'manager';
  }
  return { actor, watch };
}
