import type { Envelope } from '../../platform/crypto.ts';
import { run } from '../../platform/db.ts';

/** An org credential at revision 1 with one sealed version, written as a rotation writes it (event, then pointer). */
export async function seedWalletCredentialVersion(
  db: D1Database,
  c: {
    orgId: string;
    now: number;
    id: () => string;
    seal: (rowId: string, orgId: string, kind: string, text: string) => Promise<Envelope>;
  },
) {
  const credentialId = c.id();
  const versionId = c.id();
  const kind = `wallet-credential:${credentialId}:org:live:google`;
  const text = 'wallet-credential-body';
  const sealed = await c.seal(versionId, c.orgId, kind, text);
  const identity = 'a'.repeat(64);
  await run(
    db,
    `INSERT INTO wallet_credentials (id, scope, org_id, mode, provider, identity_hash, identity_hint, created_at, updated_at)
     VALUES (?, 'org', ?, 'live', 'google', ?, 'abcd', ?, ?)`,
    [credentialId, c.orgId, identity, c.now, c.now],
  );
  await run(
    db,
    `INSERT INTO wallet_credential_versions (id, credential_id, identity_hash, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionId,
      credentialId,
      identity,
      sealed.kekVersion,
      sealed.iv,
      sealed.wrappedDek,
      sealed.ciphertext,
      c.now,
    ],
  );
  await run(
    db,
    `INSERT INTO wallet_credential_events (id, credential_id, revision, kind, version_id, actor_type)
     VALUES (?, ?, 1, 'create', ?, 'system')`,
    [c.id(), credentialId, versionId],
  );
  await run(db, 'UPDATE wallet_credentials SET revision = 1, current_version_id = ? WHERE id = ?', [
    versionId,
    credentialId,
  ]);
  return { table: 'wallet_credential_versions', id: versionId, org: c.orgId, kind, text };
}
