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
    AND EXISTS (SELECT 1 FROM audit_log a WHERE a.target_type = 'identity' AND a.target_id = signing_identities.id
      AND a.action = 'identity.apns_probe' AND a.at >= ?)
    AND ${DEVICE_TEST}`;
}

/** The owner's device test: a registration of a pass in a platform admin's personal org, signed by the row. */
const DEVICE_TEST = `EXISTS (SELECT 1 FROM registrations r JOIN passes p ON p.id = r.pass_id
    JOIN orgs o ON o.id = p.org_id
    WHERE r.identity_id = signing_identities.id AND o.personal_user_id IS NOT NULL)`;

/** True while any device still registers a pass signed by this identity. */
export async function hasRegistrations(db: D1Database, identityId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    'SELECT 1 AS ok FROM registrations WHERE identity_id = ? LIMIT 1',
    [identityId],
  );
  return row !== null;
}

/** A push probe must be this fresh for a flip. */
export const PROBE_FRESH_MS = 86_400_000;

/** True when the owner's device test (O5) passed: a platform admin's own device registered a pass of the row. */
export async function deviceTestPassed(db: D1Database, identityId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM signing_identities WHERE id = ? AND ${DEVICE_TEST}`,
    [identityId],
  );
  return row !== null;
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
  // The legacy row's checks take the time once; a new default's also take the cut-off for its push probe.
  const readyArgs = legacy ? [now] : [now, now - PROBE_FRESH_MS];
  const isDefault = 'EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND is_default = 1)';
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE signing_identities SET is_default = 0
       WHERE is_default = 1 AND EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND ${ready})`,
      [target.id, ...readyArgs],
    ),
    stmt(
      db,
      `UPDATE signing_identities SET is_default = 1, issuing = 1
       WHERE id = ? AND is_default = 0 AND ${ready}
         AND NOT EXISTS (SELECT 1 FROM signing_identities WHERE is_default = 1)`,
      [target.id, ...readyArgs],
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
