import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { setupMeta, watchOf } from './repo-setups.ts';

export interface LiveAttachment {
  orgId: string;
  mode: Mode;
  scannerId: string;
  role: 'customer' | 'monitor';
  tokenHash: string;
  revision: number;
  expiresAt: number;
}

/** Read authoritative rows before each delivery; a cached socket never extends a credential. */
export async function liveRecipient(ctx: ServiceContext, a: LiveAttachment) {
  const now = ctx.clock.now();
  if (a.expiresAt <= now) return null;
  const [row, meta, active] = await Promise.all([
    getScanner(ctx.env.DB, a.scannerId),
    setupMeta(ctx.env.DB, a.orgId, a.scannerId),
    orgIsActive(ctx.env.DB, a.orgId),
  ]);
  if (
    !row ||
    !active ||
    row.orgId !== a.orgId ||
    row.mode !== a.mode ||
    row.deviceRole !== a.role ||
    row.revokedAt !== null ||
    row.tokenHash !== a.tokenHash ||
    row.updatedAt !== a.revision ||
    row.expiresAt === null ||
    row.expiresAt <= now
  )
    return null;
  const watch = watchOf(meta);
  if (!watch || (a.role === 'customer' && watch.allOrg)) return null;
  const actor = withRole(
    scannerActor(ctx, row, row.mode, 'cookie', { event: null, templateIds: [] }),
    null,
  );
  return { actor, watch };
}
