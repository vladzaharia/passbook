import { batch, first, stmt } from '../../platform/db.ts';
import { auditStmtWhere } from '../audit/repo.ts';
import type { AuditEntry } from '../audit/types.ts';
import { PLATFORM_IDENTITY_ID } from './env-identity.ts';
import type { IdentityRow } from './repo.ts';

type Ctx = Parameters<typeof auditStmtWhere>[1];

/** Rows a flip needs: the target's own checks, stated once so the atomic batch re-checks what the service read. */
function readySql(legacy: boolean): string {
  const live = 'cert_pem IS NOT NULL AND (not_after IS NULL OR not_after > ?)';
  if (legacy) return `id = '${PLATFORM_IDENTITY_ID}' AND source = 'env' AND ${live}`;
  return `id <> '${PLATFORM_IDENTITY_ID}' AND org_id IS NULL AND purpose = 'passes' AND issuing = 1
    AND apns_health = 'healthy' AND ${live}
    AND EXISTS (SELECT 1 FROM registrations r WHERE r.identity_id = signing_identities.id)`;
}

/** Devices that registered a pass signed by this identity: the owner's device test (O5). */
export async function registeredDeviceCount(db: D1Database, identityId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM (SELECT 1 FROM registrations WHERE identity_id = ? LIMIT 1)',
    [identityId],
  );
  return row?.n ?? 0;
}

/**
 * The default moves in one batch. Each write is guarded by the target's checks, so a certificate
 * that expired or a push that failed between the read and the write changes nothing. The legacy row
 * stops issuing only after the new default is set; the reverse flip (target `platform`) resumes it.
 * Returns whether the default moved.
 */
export async function switchDefault(
  db: D1Database,
  ctx: Ctx,
  target: IdentityRow,
  now: number,
  audit: AuditEntry,
): Promise<boolean> {
  const legacy = target.id === PLATFORM_IDENTITY_ID;
  const ready = readySql(legacy);
  const isDefault = 'EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND is_default = 1)';
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE signing_identities SET is_default = 0
       WHERE is_default = 1 AND EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND ${ready})`,
      [target.id, now],
    ),
    stmt(
      db,
      `UPDATE signing_identities SET is_default = 1, issuing = 1
       WHERE id = ? AND is_default = 0 AND ${ready}
         AND NOT EXISTS (SELECT 1 FROM signing_identities WHERE is_default = 1)`,
      [target.id, now],
    ),
    ...(legacy
      ? []
      : [
          stmt(
            db,
            `UPDATE signing_identities SET issuing = 0 WHERE id = '${PLATFORM_IDENTITY_ID}' AND ${isDefault}`,
            [target.id],
          ),
        ]),
    auditStmtWhere(db, ctx, audit, isDefault, [target.id]),
  ]);
  // Triggers on the row add to the count, so any change means the guard held.
  return (results[1]?.meta.changes ?? 0) > 0;
}

/** The default platform row's pass type and team; the env values while no platform default row exists. */
export async function defaultPlatformPassIdentity(
  db: D1Database,
  fallback: { passTypeIdentifier: string; teamIdentifier: string },
): Promise<{ passTypeIdentifier: string; teamIdentifier: string }> {
  const row = await first<{ pass_type_identifier: string; team_identifier: string }>(
    db,
    `SELECT pass_type_identifier, team_identifier FROM signing_identities
     WHERE is_default = 1 AND org_id IS NULL AND purpose = 'passes'`,
  );
  return row
    ? { passTypeIdentifier: row.pass_type_identifier, teamIdentifier: row.team_identifier }
    : fallback;
}
