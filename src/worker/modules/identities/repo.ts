import { certificateInfo } from '../../../passkit/sign/index.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { PLATFORM_IDENTITY_ID, readEnvIdentity } from './env-identity.ts';

/** Upserts the env-sourced platform signing identity row (needed by passes.identity_id FK). Idempotent. */
export async function ensurePlatformIdentity(env: AppEnv, now: number): Promise<void> {
  const identity = readEnvIdentity(env);
  const info = await certificateInfo(identity.material.certificate);
  const existing = await first<{ cert_sha256: string | null }>(
    env.DB,
    'SELECT cert_sha256 FROM signing_identities WHERE id = ?',
    [PLATFORM_IDENTITY_ID],
  );
  if (existing?.cert_sha256 === info.sha256) return;
  await run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, cert_pem, cert_sha256,
        not_before, not_after, apns_binding, is_default, created_at)
     VALUES (?, NULL, 'Platform', ?, ?, 'env', 'PLATFORM', ?, ?, ?, ?, ?,
       NOT EXISTS (SELECT 1 FROM signing_identities WHERE is_default = 1), ?)
     ON CONFLICT (id) DO UPDATE SET
       pass_type_identifier = excluded.pass_type_identifier, team_identifier = excluded.team_identifier,
       cert_pem = excluded.cert_pem, cert_sha256 = excluded.cert_sha256,
       not_before = excluded.not_before, not_after = excluded.not_after, apns_binding = excluded.apns_binding`,
    [
      PLATFORM_IDENTITY_ID,
      identity.passTypeIdentifier,
      identity.teamIdentifier,
      identity.material.certificate,
      info.sha256,
      info.notBefore.getTime(),
      info.notAfter.getTime(),
      identity.apnsBinding,
      now,
    ],
  );
}

export interface IdentityRow {
  id: string;
  org_id: string | null;
  label: string;
  pass_type_identifier: string;
  team_identifier: string;
  source: 'env' | 'db';
  env_prefix: string | null;
  credential_id: string | null;
  cert_pem: string | null;
  cert_sha256: string | null;
  not_before: number | null;
  not_after: number | null;
  apns_binding: string | null;
  apns_health: 'unknown' | 'healthy' | 'failing';
  nfc_enabled: number;
  is_default: number;
  created_at: number;
}

export interface CredentialBlob {
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

const COLUMNS = `id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, credential_id,
  cert_pem, cert_sha256, not_before, not_after, apns_binding, apns_health, nfc_enabled, is_default, created_at`;

export function listIdentityRows(db: D1Database): Promise<IdentityRow[]> {
  return all<IdentityRow>(db, `SELECT ${COLUMNS} FROM signing_identities ORDER BY created_at, id`);
}

export function getIdentityRow(db: D1Database, id: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT ${COLUMNS} FROM signing_identities WHERE id = ?`, [id]);
}

export function findByPassType(db: D1Database, passTypeIdentifier: string) {
  return first<{ id: string }>(
    db,
    'SELECT id FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeIdentifier],
  );
}

export function getDefaultRow(db: D1Database): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT ${COLUMNS} FROM signing_identities WHERE is_default = 1`);
}

export async function orgDefaultIdentityId(db: D1Database, orgId: string): Promise<string | null> {
  const row = await first<{ default_identity_id: string | null }>(
    db,
    "SELECT default_identity_id FROM orgs WHERE id = ? AND status != 'deleted'",
    [orgId],
  );
  return row?.default_identity_id ?? null;
}

export async function orgExists(db: D1Database, orgId: string): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 AS x FROM orgs WHERE id = ? AND status != 'deleted'", [orgId])) !==
    null
  );
}

export function getCredentialBlob(db: D1Database, id: string): Promise<CredentialBlob | null> {
  return first<CredentialBlob>(
    db,
    'SELECT kek_version, iv, wrapped_dek, ciphertext FROM credentials WHERE id = ?',
    [id],
  );
}

export interface NewIdentity {
  credential: {
    id: string;
    orgId: string | null;
    kekVersion: number;
    iv: Uint8Array;
    wrappedDek: Uint8Array;
    ciphertext: Uint8Array;
    fingerprint: string;
  };
  identity: {
    id: string;
    orgId: string | null;
    label: string;
    passTypeIdentifier: string;
    teamIdentifier: string;
    certPem: string;
    certSha256: string;
    notBefore: number;
    notAfter: number;
    nfcEnabled: boolean;
  };
  now: number;
}

/** Credential and identity rows are written together or not at all. */
export async function insertIdentity(db: D1Database, n: NewIdentity): Promise<void> {
  const c = n.credential;
  const i = n.identity;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, n.now],
    ),
    stmt(
      db,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, cert_sha256,
          not_before, not_after, nfc_enabled, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, 'db', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        i.id,
        i.orgId,
        i.label,
        i.passTypeIdentifier,
        i.teamIdentifier,
        c.id,
        i.certPem,
        i.certSha256,
        i.notBefore,
        i.notAfter,
        i.nfcEnabled,
        n.now,
      ],
    ),
  ]);
}

export interface IdentityPatch {
  label: string;
  nfcEnabled: boolean;
  apnsBinding: string | null;
  isDefault: boolean;
}

export async function updateIdentityRow(
  db: D1Database,
  id: string,
  patch: IdentityPatch,
): Promise<void> {
  const update = stmt(
    db,
    'UPDATE signing_identities SET label = ?, nfc_enabled = ?, apns_binding = ?, is_default = ? WHERE id = ?',
    [patch.label, patch.nfcEnabled, patch.apnsBinding, patch.isDefault, id],
  );
  // The partial unique index allows one default; clear the old one first.
  await batch(
    db,
    patch.isDefault
      ? [
          stmt(
            db,
            'UPDATE signing_identities SET is_default = 0 WHERE is_default = 1 AND id != ?',
            [id],
          ),
          update,
        ]
      : [update],
  );
}

export async function identityInUse(db: D1Database, id: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS x FROM passes WHERE identity_id = ? LIMIT 1', [id])) !== null
  );
}

export async function deleteIdentityRows(
  db: D1Database,
  id: string,
  credentialId: string | null,
): Promise<void> {
  await batch(db, [
    stmt(db, 'DELETE FROM signing_identities WHERE id = ?', [id]),
    ...(credentialId ? [stmt(db, 'DELETE FROM credentials WHERE id = ?', [credentialId])] : []),
  ]);
}

export interface IdentityRotation {
  identityId: string;
  oldCredentialId: string | null;
  credential: NewIdentity['credential'];
  certPem: string;
  certSha256: string;
  notBefore: number;
  notAfter: number;
  now: number;
}

export async function setProbeHealth(
  db: D1Database,
  id: string,
  health: 'healthy' | 'failing',
): Promise<void> {
  await run(db, 'UPDATE signing_identities SET apns_health = ? WHERE id = ?', [health, id]);
}

/** Swaps cert and key atomically: new credential, repoint, drop the old credential. */
export async function rotateIdentityRows(db: D1Database, r: IdentityRotation): Promise<void> {
  const c = r.credential;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at, rotated_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, r.now, r.now],
    ),
    stmt(
      db,
      `UPDATE signing_identities
         SET credential_id = ?, cert_pem = ?, cert_sha256 = ?, not_before = ?, not_after = ?, apns_health = 'unknown'
       WHERE id = ?`,
      [c.id, r.certPem, r.certSha256, r.notBefore, r.notAfter, r.identityId],
    ),
    ...(r.oldCredentialId
      ? [stmt(db, 'DELETE FROM credentials WHERE id = ?', [r.oldCredentialId])]
      : []),
  ]);
}
