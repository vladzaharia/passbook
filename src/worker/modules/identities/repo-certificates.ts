import { all, batch, first, stmt } from '../../platform/db.ts';
import type { NewIdentity } from './repo.ts';

export interface CertificateRow {
  id: string;
  identity_id: string;
  credential_id: string | null;
  cert_sha256: string | null;
  not_before: number | null;
  not_after: number | null;
  asc_certificate_id: string | null;
  origin: 'upload' | 'asc' | 'csr' | 'env';
  state: 'pending' | 'active' | 'superseded' | 'revoked' | 'failed';
  created_at: number;
  activated_at: number | null;
  ended_at: number | null;
}

const COLUMNS = `id, identity_id, credential_id, cert_sha256, not_before, not_after, asc_certificate_id,
  origin, state, created_at, activated_at, ended_at`;

export function getCertificateRow(db: D1Database, id: string): Promise<CertificateRow | null> {
  return first<CertificateRow>(db, `SELECT ${COLUMNS} FROM identity_certificates WHERE id = ?`, [
    id,
  ]);
}

/** Oldest first. */
export function listCertificateRows(db: D1Database, identityId: string): Promise<CertificateRow[]> {
  return all<CertificateRow>(
    db,
    `SELECT ${COLUMNS} FROM identity_certificates WHERE identity_id = ? ORDER BY created_at, id`,
    [identityId],
  );
}

/** A pending row whose key credential carries this public-key hash (a retried begin finds its own key). */
export function findPendingByPubkey(
  db: D1Database,
  identityId: string,
  pubkeySha256: string,
): Promise<CertificateRow | null> {
  return first<CertificateRow>(
    db,
    `SELECT ic.id, ic.identity_id, ic.credential_id, ic.cert_sha256, ic.not_before, ic.not_after,
       ic.asc_certificate_id, ic.origin, ic.state, ic.created_at, ic.activated_at, ic.ended_at
     FROM identity_certificates ic
     JOIN credentials c ON c.id = ic.credential_id
     WHERE ic.identity_id = ? AND ic.state = 'pending' AND c.fingerprint = ?`,
    [identityId, pubkeySha256],
  );
}

export interface PendingCertificate {
  id: string;
  identityId: string;
  origin: CertificateRow['origin'];
  credential: NewIdentity['credential'];
  now: number;
}

/** The key credential (fingerprint = public-key hash) and its pending history row, together. */
export async function insertPendingCertificate(
  db: D1Database,
  p: PendingCertificate,
): Promise<void> {
  const c = p.credential;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, p.now],
    ),
    stmt(
      db,
      `INSERT INTO identity_certificates (id, identity_id, credential_id, origin, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [p.id, p.identityId, c.id, p.origin, p.now],
    ),
  ]);
}

export interface Activation {
  certId: string;
  identityId: string;
  pendingCredentialId: string;
  /** The identity as the caller read it. The swap only happens if it is still exactly this. */
  expectedRevision: number;
  expectedCredentialId: string | null;
  certPem: string;
  certSha256: string;
  notBefore: number;
  notAfter: number;
  ascCertificateId: string | null;
  now: number;
}

/**
 * Pending to active in one batch, compare-and-swap on the identity's revision and credential. The
 * old active row becomes superseded, the identity points at the pending key and certificate, and
 * the credential it replaced is deleted. Returns false, with nothing changed, when the identity
 * moved since it was read (a racing activation or upload). The identities triggers see the active
 * row for this certificate and add no history of their own.
 */
export async function activateCertificate(db: D1Database, a: Activation): Promise<boolean> {
  const identityUnchanged = `EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND revision = ? AND credential_id IS ?)`;
  const identityParams = [a.identityId, a.expectedRevision, a.expectedCredentialId];
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE identity_certificates SET state = 'superseded', ended_at = ?
       WHERE identity_id = ? AND state = 'active'
         AND EXISTS (SELECT 1 FROM identity_certificates WHERE id = ? AND state = 'pending')
         AND ${identityUnchanged}`,
      [a.now, a.identityId, a.certId, ...identityParams],
    ),
    stmt(
      db,
      `UPDATE identity_certificates
         SET state = 'active', cert_sha256 = ?, not_before = ?, not_after = ?, asc_certificate_id = ?, activated_at = ?
       WHERE id = ? AND state = 'pending' AND ${identityUnchanged}`,
      [
        a.certSha256,
        a.notBefore,
        a.notAfter,
        a.ascCertificateId,
        a.now,
        a.certId,
        ...identityParams,
      ],
    ),
    stmt(
      db,
      `UPDATE signing_identities
         SET credential_id = ?, cert_pem = ?, cert_sha256 = ?, not_before = ?, not_after = ?, apns_health = 'unknown'
       WHERE id = ? AND revision = ? AND credential_id IS ?
         AND EXISTS (SELECT 1 FROM identity_certificates WHERE id = ? AND state = 'active' AND cert_sha256 = ?)`,
      [
        a.pendingCredentialId,
        a.certPem,
        a.certSha256,
        a.notBefore,
        a.notAfter,
        ...identityParams,
        a.certId,
        a.certSha256,
      ],
    ),
    stmt(
      db,
      `DELETE FROM credentials WHERE id = ? AND id != ?
         AND EXISTS (SELECT 1 FROM signing_identities WHERE id = ? AND credential_id = ?)`,
      [a.expectedCredentialId, a.pendingCredentialId, a.identityId, a.pendingCredentialId],
    ),
  ]);
  // Step 2 and the identity swap share one guard inside one transaction; the swap's own count
  // includes trigger writes, so the history row is the signal.
  return results[1]?.meta.changes === 1;
}

/** Pending to failed; the unused key is deleted. */
export async function failPendingCertificate(
  db: D1Database,
  certId: string,
  now: number,
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      `DELETE FROM credentials WHERE id = (SELECT credential_id FROM identity_certificates WHERE id = ? AND state = 'pending')`,
      [certId],
    ),
    stmt(
      db,
      `UPDATE identity_certificates SET state = 'failed', ended_at = ? WHERE id = ? AND state = 'pending'`,
      [now, certId],
    ),
  ]);
}
