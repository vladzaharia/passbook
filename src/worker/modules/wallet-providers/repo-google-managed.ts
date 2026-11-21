import { all, first, run } from '../../platform/db.ts';
import type { SourceVersionRow } from './repo-account-source.ts';
import type { CredentialRow } from './repo-credentials.ts';

const COLUMNS =
  'id, scope, org_id, mode, provider, identity_hash, identity_hint, provenance, signer_ref, next_rotation_at, revision, current_version_id, verified_at, revoked_at, created_at, updated_at';

/** The platform's active Google credential of a mode: PassBook's service account and parent issuer. */
export function activePlatformGoogle(
  db: D1Database,
  mode: 'live' | 'test',
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND mode = ? AND revoked_at IS NULL
       AND current_version_id IS NOT NULL`,
    [mode],
  );
}

/** The org's active Google credential of a mode. */
export function activeOrgGoogle(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'org' AND org_id = ? AND provider = 'google' AND mode = ? AND revoked_at IS NULL`,
    [orgId, mode],
  );
}

/** Credentials whose key is the platform credential's, after `after`, oldest id first. */
export function signedBy(
  db: D1Database,
  signerId: string,
  after: string,
  limit: number,
): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE signer_ref = ? AND revoked_at IS NULL AND current_version_id IS NOT NULL AND id > ?
     ORDER BY id LIMIT ?`,
    [signerId, after, limit],
  );
}

/** Active platform Google credentials whose rotation is due. */
export function dueKeyRotations(db: D1Database, now: number): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND revoked_at IS NULL
       AND next_rotation_at IS NOT NULL AND next_rotation_at <= ? ORDER BY next_rotation_at LIMIT 10`,
    [now],
  );
}

export function platformGoogleCredentials(db: D1Database): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND revoked_at IS NULL
       AND current_version_id IS NOT NULL ORDER BY id`,
  );
}

export interface SaKeyRow {
  key_name: string;
  credential_id: string;
  origin: 'created' | 'adopted';
  state: 'pending' | 'active' | 'retiring' | 'retired';
  created_at: number;
  deleted_at: number | null;
}

/** Keys of one service account that PassBook created or adopted and has not deleted. */
export function liveKeysOf(db: D1Database, email: string): Promise<SaKeyRow[]> {
  return all<SaKeyRow>(
    db,
    `SELECT key_name, credential_id, origin, state, created_at, deleted_at FROM wallet_sa_keys
     WHERE deleted_at IS NULL AND instr(key_name, ?) > 0 ORDER BY created_at, key_name`,
    [`/serviceAccounts/${email}/keys/`],
  );
}

export async function recordKey(
  db: D1Database,
  key: {
    name: string;
    credentialId: string;
    origin: 'created' | 'adopted';
    state: SaKeyRow['state'];
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO wallet_sa_keys (key_name, credential_id, origin, state, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [key.name, key.credentialId, key.origin, key.state, key.now],
  );
}

export async function setKeyState(
  db: D1Database,
  name: string,
  state: SaKeyRow['state'],
  now: number,
): Promise<void> {
  await run(
    db,
    'UPDATE wallet_sa_keys SET state = ?, deleted_at = CASE WHEN ? = ? THEN ? ELSE deleted_at END WHERE key_name = ?',
    [state, state, 'retired', now, name],
  );
}

export async function keyState(db: D1Database, name: string): Promise<SaKeyRow['state'] | null> {
  const row = await first<{ state: SaKeyRow['state'] }>(
    db,
    'SELECT state FROM wallet_sa_keys WHERE key_name = ?',
    [name],
  );
  return row?.state ?? null;
}

/** Keys made but never switched in, with no rotation run open for their credential. */
export function orphanKeys(db: D1Database, olderThan: number): Promise<SaKeyRow[]> {
  return all<SaKeyRow>(
    db,
    `SELECT key_name, credential_id, origin, state, created_at, deleted_at FROM wallet_sa_keys k
     WHERE state = 'pending' AND created_at < ? AND NOT EXISTS (
       SELECT 1 FROM identity_runs r WHERE r.provider = 'google' AND r.kind = 'rotate'
         AND r.target_id = k.credential_id AND r.state IN ('queued', 'running', 'waiting'))`,
    [olderThan],
  );
}

/** Parked rotation runs whose old key may now be deleted. */
export function cooledRotationRuns(db: D1Database, now: number): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM identity_runs
     WHERE provider = 'google' AND kind = 'rotate' AND state = 'waiting'
       AND waiting_for = 'old_key_cooldown'
       AND CAST(json_extract(external_ref, '$.deleteAfter') AS INTEGER) <= ?
     ORDER BY id LIMIT 25`,
    [now],
  );
}

/** Moves a parked run back to the queue. False when it is no longer waiting. */
export async function resumeRun(db: D1Database, id: string, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE identity_runs SET state = 'queued', waiting_for = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND provider = 'google' AND state = 'waiting'`,
    [now, id],
  );
  return changes === 1;
}

/** A credential's version (the current one when `versionId` is null) with the parts needed to open it. */
export function versionRow(
  db: D1Database,
  credentialId: string,
  versionId: string | null,
): Promise<SourceVersionRow | null> {
  return first<SourceVersionRow>(
    db,
    `SELECT v.id AS version_id, v.credential_id, v.identity_hash AS version_identity, v.card_map,
       v.kek_version, v.iv, v.wrapped_dek, v.ciphertext, c.scope, c.org_id AS credential_org_id, c.mode,
       c.provider, c.identity_hash AS credential_identity, c.revoked_at
     FROM wallet_credentials c
     JOIN wallet_credential_versions v ON v.credential_id = c.id AND v.id = COALESCE(?, c.current_version_id)
     WHERE c.id = ?`,
    [versionId, credentialId],
  );
}

/** Claims a run for one job: false while another holds an unexpired lease. A crashed holder's lease runs out. */
export async function claimRun(
  db: D1Database,
  id: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE identity_runs SET state = 'running', lease_until = ?, attempt = attempt + 1, updated_at = ?
     WHERE id = ? AND provider = 'google' AND state IN ('queued', 'running')
       AND (lease_until IS NULL OR lease_until < ?)`,
    [now + leaseMs, now, id, now],
  );
  return changes === 1;
}

export async function releaseRun(db: D1Database, id: string): Promise<void> {
  await run(db, 'UPDATE identity_runs SET lease_until = NULL WHERE id = ?', [id]);
}

/** Provision runs another job is working on right now. */
export async function busyIssuerRuns(db: D1Database, now: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM identity_runs
     WHERE provider = 'google' AND kind = 'provision' AND state = 'running' AND lease_until > ?`,
    [now],
  );
  return row?.n ?? 0;
}

export interface ClaimRow {
  issuer_id: string;
  org_id: string;
  origin: 'created' | 'shared' | 'manual';
}

export function getClaim(db: D1Database, issuerId: string): Promise<ClaimRow | null> {
  return first<ClaimRow>(
    db,
    'SELECT issuer_id, org_id, origin FROM wallet_google_issuers WHERE issuer_id = ?',
    [issuerId],
  );
}

/** False when the issuer already has a claim. */
export async function insertClaim(db: D1Database, c: ClaimRow & { now: number }): Promise<boolean> {
  const { changes } = await run(
    db,
    'INSERT OR IGNORE INTO wallet_google_issuers (issuer_id, org_id, origin, claimed_at) VALUES (?, ?, ?, ?)',
    [c.issuer_id, c.org_id, c.origin, c.now],
  );
  return changes === 1;
}

/** Moves a claim from the org that held it; false when it moved meanwhile. */
export async function moveClaim(
  db: D1Database,
  c: ClaimRow & { from: string; now: number },
): Promise<boolean> {
  const { changes } = await run(
    db,
    'UPDATE wallet_google_issuers SET org_id = ?, origin = ?, claimed_at = ? WHERE issuer_id = ? AND org_id = ?',
    [c.org_id, c.origin, c.now, c.issuer_id, c.from],
  );
  return changes === 1;
}

export async function claimedIssuersOf(db: D1Database, orgId: string): Promise<ClaimRow[]> {
  return all<ClaimRow>(
    db,
    "SELECT issuer_id, org_id, origin FROM wallet_google_issuers WHERE org_id = ? AND origin = 'created' ORDER BY claimed_at",
    [orgId],
  );
}

/** Does the org hold an active Google credential for this issuer (any mode)? */
export async function orgHoldsIssuer(
  db: D1Database,
  orgId: string,
  identityHash: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM wallet_credentials WHERE scope = 'org' AND org_id = ? AND provider = 'google'
       AND identity_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [orgId, identityHash],
  );
  return row !== null;
}

/** PassBook's own issuers (any mode, revoked or not) are no org's to claim. */
export async function platformHoldsIssuer(db: D1Database, identityHash: string): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    "SELECT id FROM wallet_credentials WHERE scope = 'platform' AND provider = 'google' AND identity_hash = ? LIMIT 1",
    [identityHash],
  );
  return row !== null;
}

/** Verified addresses of the org's active admins: who may prove they own an issuer. */
export async function orgAdminEmails(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await all<{ email: string }>(
    db,
    `SELECT DISTINCT e.email FROM org_memberships m
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     JOIN user_emails e ON e.user_id = u.id
     WHERE m.org_id = ? AND m.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value = 'org_admin')`,
    [orgId],
  );
  return rows.map((r) => r.email);
}
