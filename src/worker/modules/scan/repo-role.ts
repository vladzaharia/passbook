import type { StoredEffectiveSurface } from '../../../shared/scan-surfaces.ts';
import { grant } from '../../platform/authority.ts';
import { epochIs, exactlyOne } from '../../platform/authority-checks.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audited } from './repo-admin-grant.ts';
import { addScanningDeviceUpdate, type ScanningDeviceRow } from './repo-scanning-devices.ts';

const ROLE_CODES = { config: 'SCAN_CONFIG_CHANGED', lineage: 'SCAN_CONFIG_CHANGED' } as const;

/** Whether the org has anyone who could hold a PIN. */
export const hasActiveStaff = async (db: D1Database, orgId: string): Promise<boolean> =>
  (
    await first<{ has: number }>(
      db,
      'SELECT EXISTS (SELECT 1 FROM scan_staff WHERE org_id = ? AND disabled_at IS NULL) AS has',
      [orgId],
    )
  )?.has === 1;

/** Every active staff member, for a PIN that names no one. Bounded: each is hashed per attempt. */
export const unlockRosterStatement = (db: D1Database, orgId: string) =>
  stmt(
    db,
    `SELECT id, org_id, name, role, pin_hash, disabled_at, updated_at, auth_epoch FROM scan_staff
     WHERE org_id = ? AND disabled_at IS NULL ORDER BY id LIMIT 200`,
    [orgId],
  );

export interface RoleFlip {
  scannerId: string;
  orgId: string;
  from: 'scan' | 'customer';
  to: 'scan' | 'customer';
  credentialEpoch: number;
  configEpoch: number;
  /** The device's own row, when it belongs to a scanning session. */
  device: ScanningDeviceRow | null;
  surface: StoredEffectiveSurface;
  unlockedBy: string | null;
}

/**
 * The device changes its own role while its credential and configuration are the ones the request
 * was derived from. Only a `kind: device` row that holds `from` can move.
 */
export async function commitRoleFlip(ctx: ServiceContext, flip: RoleFlip): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org_mode.scan.device.update',
    principal: {
      kind: 'scanner',
      scannerId: flip.scannerId,
      credentialEpoch: flip.credentialEpoch,
    },
    checks: [
      epochIs('scanners', flip.scannerId, 'config_epoch', flip.configEpoch),
      exactlyOne(
        'scanners',
        { id: flip.scannerId, kind: 'device', device_role: flip.from, revoked_at: null },
        undefined,
        'config',
      ),
    ],
    tables: ['scanners', 'scanning_devices'],
    target: flip.scannerId,
    codes: ROLE_CODES,
  });
  if (flip.device)
    addScanningDeviceUpdate(
      g,
      flip.scannerId,
      flip.to === 'customer' ? 'customer' : 'auto',
      flip.surface,
      JSON.parse(flip.device.overrides),
    );
  g.update('scanners', {
    set: { device_role: flip.to, updated_at: maxNow(ctx.clock.now()) },
    where: { id: flip.scannerId },
    require: 'one',
  });
  g.add(
    audited(g, ctx, {
      orgId: flip.orgId,
      actorType: 'scanner',
      actorId: flip.scannerId,
      action: 'scanner.role_change',
      targetType: 'scanner',
      targetId: flip.scannerId,
      detail: { from: flip.from, to: flip.to, via: 'device', unlockedBy: flip.unlockedBy },
    }),
  );
  await g.commit();
}
