import type { Envelope } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { type ConnectionAuthority, connectionAuthPredicate } from './access.ts';

// Credentials

export interface CredentialRow {
  id: string;
  orgId: string | null;
  envelope: Envelope;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value as number[]);
}

export async function insertCredential(
  db: D1Database,
  c: {
    id: string;
    orgId: string;
    kind: 'connector' | 'webhook';
    envelope: Envelope;
    fingerprint: string;
    createdBy: string | null;
    now: number;
  },
  authority?: ConnectionAuthority,
): Promise<boolean> {
  const auth = authority ? connectionAuthPredicate(authority, 'subject.org_id', c.now) : null;
  const result = await run(
    db,
    `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_by, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${auth ? ` FROM (SELECT ? AS org_id) subject WHERE ${auth.sql}` : ''}`,
    [
      c.id,
      c.orgId,
      c.kind,
      c.envelope.kekVersion,
      c.envelope.iv,
      c.envelope.wrappedDek,
      c.envelope.ciphertext,
      c.fingerprint,
      c.createdBy,
      c.now,
      ...(auth ? [c.orgId, ...auth.params] : []),
    ],
  );
  return result.changes === 1;
}

export async function getCredential(
  db: D1Database,
  orgId: string,
  id: string,
): Promise<CredentialRow | null> {
  const r = await first<{
    id: string;
    org_id: string | null;
    kek_version: number;
    iv: unknown;
    wrapped_dek: unknown;
    ciphertext: unknown;
  }>(
    db,
    'SELECT id, org_id, kek_version, iv, wrapped_dek, ciphertext FROM credentials WHERE id = ? AND org_id = ?',
    [id, orgId],
  );
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    envelope: {
      kekVersion: r.kek_version,
      iv: bytes(r.iv),
      wrappedDek: bytes(r.wrapped_dek),
      ciphertext: bytes(r.ciphertext),
    },
  };
}

export async function deleteCredentials(db: D1Database, ids: (string | null)[]): Promise<void> {
  let failed = false;
  let firstError: unknown;
  for (const id of ids) {
    if (!id) continue;
    try {
      await run(
        db,
        `DELETE FROM credentials WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM connections WHERE credential_id = credentials.id OR webhook_credential_id = credentials.id
      ) AND NOT EXISTS (
        SELECT 1 FROM signing_identities WHERE credential_id = credentials.id
      )`,
        [id],
      );
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

/** Remove a possibly committed insert only when it is exactly the unreferenced envelope. */
export async function discardCredential(
  db: D1Database,
  credential: { id: string; orgId: string; envelope: Envelope },
): Promise<void> {
  await run(
    db,
    `DELETE FROM credentials WHERE id = ? AND org_id = ? AND kek_version = ?
     AND iv = ? AND wrapped_dek = ? AND ciphertext = ?
     AND NOT EXISTS (SELECT 1 FROM connections
       WHERE credential_id = credentials.id OR webhook_credential_id = credentials.id)
     AND NOT EXISTS (SELECT 1 FROM signing_identities WHERE credential_id = credentials.id)`,
    [
      credential.id,
      credential.orgId,
      credential.envelope.kekVersion,
      credential.envelope.iv,
      credential.envelope.wrappedDek,
      credential.envelope.ciphertext,
    ],
  );
}
