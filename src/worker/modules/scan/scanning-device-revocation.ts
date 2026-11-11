import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { kickScreen } from './live.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import { assertAdminConfigurationAuthority } from './repo-scanner-configuration-authority.ts';
import { addScannerRevoke, getConsoleScanner } from './repo-scanners.ts';
import { addAdminDeviceRelease } from './repo-scanning-devices.ts';
import { loadScanner, scannerView } from './scanner-views.ts';

const REVOKE_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;

/** Idempotent: a second revoke changes and audits nothing. */
export async function revokeScanner(
  ctx: ServiceContext,
  userId: string,
  id: string,
  authority: TenantPassWrite,
) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id, authority.mode);
  if (row.revokedAt !== null) {
    await assertAdminConfigurationAuthority(db, row.orgId, {
      kind: 'admin',
      userId,
      authority,
      now: ctx.clock.now(),
    });
    return scannerView(ctx, id);
  }
  // Revoking is absolute, not derived from a read: configuration drift never blocks it.
  const g = adminGrant(
    ctx,
    'org_mode.scan.scanner.revoke',
    userId,
    authority,
    row.orgId,
    [],
    REVOKE_CODES,
    id,
  );
  addScannerRevoke(g, id, ctx.clock.now());
  addAdminDeviceRelease(g, id);
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.revoke',
      targetType: 'scanner',
      targetId: id,
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    // A concurrent revoke won: the scanner is revoked, which is what was asked.
    if (
      error instanceof AppError &&
      error.code === REVOKE_CODES.lineage &&
      (await getConsoleScanner(db, id, authority.mode))?.revokedAt != null
    )
      return scannerView(ctx, id);
    throw error;
  }
  if (row.deviceRole !== 'scan') await kickScreen(ctx, row.orgId, row.mode, id);
  return scannerView(ctx, id);
}
