import { jobGrant } from '../../platform/authority.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type PendingCertificate, pendingCertificateStmts } from './repo-certificates.ts';

export interface ProvisioningIdentity {
  id: string;
  /** Null for a platform identity. */
  orgId: string | null;
  label: string;
  passTypeIdentifier: string;
  teamIdentifier: string;
  handle: string | null;
  provenance: 'managed' | 'platform';
  purpose: 'passes' | 'device_test';
  ascPassTypeId: string;
  nfcEnabled: boolean;
  pending: PendingCertificate;
  now: number;
}

/**
 * The managed or platform identity before it has a certificate: the pending key is its credential,
 * `issuing` is 0 and nothing defaults to it, so nothing signs with it until activation.
 */
export async function insertProvisioningIdentity(
  db: D1Database,
  p: ProvisioningIdentity,
): Promise<void> {
  const pending = pendingCertificateStmts(db, p.pending);
  await batch(db, [
    pending.credential,
    stmt(
      db,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, nfc_enabled,
          is_default, issuing, provenance, purpose, rotation, handle, asc_pass_type_id, asc_account, created_at)
       VALUES (?, ?, ?, ?, ?, 'db', ?, ?, 0, 0, ?, ?, 'auto', ?, ?, 'platform', ?)`,
      [
        p.id,
        p.orgId,
        p.label,
        p.passTypeIdentifier,
        p.teamIdentifier,
        p.pending.credential.id,
        p.nfcEnabled,
        p.provenance,
        p.purpose,
        p.handle,
        p.ascPassTypeId,
        p.now,
      ],
    ),
    pending.history,
  ]);
}

export interface ManagedState {
  id: string;
  org_id: string | null;
  cert_pem: string | null;
  rotation: 'auto' | 'csr' | 'manual';
  next_rotation_at: number | null;
  asc_pass_type_id: string | null;
  handle: string | null;
}

export function getManagedState(db: D1Database, id: string): Promise<ManagedState | null> {
  return first<ManagedState>(
    db,
    `SELECT id, org_id, cert_pem, rotation, next_rotation_at, asc_pass_type_id, handle
     FROM signing_identities WHERE id = ?`,
    [id],
  );
}

/** A managed identity of the org, with or without a certificate yet. */
export function managedIdentityOf(
  db: D1Database,
  orgId: string,
): Promise<{ id: string; pass_type_identifier: string; cert_pem: string | null } | null> {
  return first(
    db,
    `SELECT id, pass_type_identifier, cert_pem FROM signing_identities
     WHERE org_id = ? AND provenance = 'managed' ORDER BY cert_pem IS NULL, created_at, id LIMIT 1`,
    [orgId],
  );
}

export function identityByPassType(db: D1Database, passTypeIdentifier: string) {
  return first<{ id: string; org_id: string | null }>(
    db,
    'SELECT id, org_id FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeIdentifier],
  );
}

/** The row for a pass type with its certificate, to tell a set-up platform slot from an empty one. */
export function identityCertByPassType(db: D1Database, passTypeIdentifier: string) {
  return first<{ id: string; org_id: string | null; cert_pem: string | null }>(
    db,
    'SELECT id, org_id, cert_pem FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeIdentifier],
  );
}

export async function setAscPassTypeId(db: D1Database, id: string, ascPassTypeId: string) {
  await run(
    db,
    "UPDATE signing_identities SET asc_pass_type_id = ?, asc_account = COALESCE(asc_account, 'platform') WHERE id = ?",
    [ascPassTypeId, id],
  );
}

export async function setNextRotation(db: D1Database, id: string, at: number) {
  await run(db, 'UPDATE signing_identities SET next_rotation_at = ? WHERE id = ?', [at, id]);
}

/** Opens a freshly activated identity to new passes. Idempotent. */
export async function openIdentity(db: D1Database, id: string) {
  await run(db, 'UPDATE signing_identities SET issuing = 1 WHERE id = ? AND issuing = 0', [id]);
}

/** New passes of the org sign with this identity. Existing passes keep their own `identity_id`. */
export async function setOrgDefaultIdentity(
  ctx: ServiceContext,
  orgId: string,
  identityId: string,
): Promise<void> {
  const g = jobGrant(ctx, {
    job: 'identity-provision',
    purpose: 'org.job.identity_default',
    orgId,
    target: identityId,
    tables: ['orgs'],
    codes: { stale: 'IDENTITY_CHANGED', config: 'IDENTITY_CHANGED' },
  });
  g.update('orgs', {
    set: { default_identity_id: identityId, updated_at: maxNow(ctx.clock.now()) },
    where: {},
  });
  await g.commit();
}

export interface DueIdentity {
  id: string;
  org_id: string | null;
}

/** Auto identities past their rotation time with no open rotate run. */
export function dueRotations(db: D1Database, now: number, limit: number): Promise<DueIdentity[]> {
  return all<DueIdentity>(
    db,
    `SELECT s.id, s.org_id FROM signing_identities s
     WHERE s.rotation = 'auto' AND s.next_rotation_at IS NOT NULL AND s.next_rotation_at <= ?
       AND s.cert_pem IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM identity_runs r
         WHERE r.target_type = 'identity' AND r.target_id = s.id AND r.kind = 'rotate'
           AND r.state IN ('queued', 'running', 'waiting'))
     ORDER BY s.next_rotation_at, s.id LIMIT ?`,
    [now, limit],
  );
}

export interface AutoIdentity {
  id: string;
  org_id: string | null;
  label: string;
  pass_type_identifier: string;
  not_after: number;
}

/** Auto identities that expire before `before`: the failure ladder's input. */
export function autoIdentitiesExpiring(db: D1Database, before: number): Promise<AutoIdentity[]> {
  return all<AutoIdentity>(
    db,
    `SELECT id, org_id, label, pass_type_identifier, not_after FROM signing_identities
     WHERE rotation = 'auto' AND cert_pem IS NOT NULL AND not_after IS NOT NULL AND not_after <= ?
     ORDER BY not_after, id`,
    [before],
  );
}

/** Active platform admins that can receive mail (the break-glass account has a reserved address). */
export async function platformAdminEmails(db: D1Database): Promise<string[]> {
  const rows = await all<{ primary_email: string }>(
    db,
    `SELECT primary_email FROM users
     WHERE status = 'active' AND primary_email IS NOT NULL AND primary_email NOT LIKE '%.invalid'
       AND EXISTS (SELECT 1 FROM json_each(last_roles) r WHERE r.type = 'text' AND r.value = 'admin')
     ORDER BY primary_email`,
  );
  return rows.map((r) => r.primary_email);
}

/** The handle an org already holds: one managed pass type per org. */
export async function handleOfOrg(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ handle: string }>(
    db,
    'SELECT handle FROM identity_handles WHERE org_id = ? ORDER BY reserved_at, handle LIMIT 1',
    [orgId],
  );
  return row?.handle ?? null;
}

/** A passes reissue for the identity finished after `since`: installed passes carry the new signature. */
export async function reissueDrained(
  db: D1Database,
  identityId: string,
  since: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 AS x FROM workflow_runs
       WHERE kind = 'bulk_reissue' AND target_id = ? AND status = 'complete' AND started_at >= ? LIMIT 1`,
      [identityId, since],
    )) !== null
  );
}
