// Credentials whose versions hold a real envelope, on top of the 0112 fixtures (which write placeholder bytes).
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { credentialIdentityHash, type SourceCredentials } from './account-credential-source.ts';
import { GOOGLE_WALLET_SCOPE } from './google-credentials.ts';
import {
  type Cred,
  credential,
  credentialRevision,
  db,
  uid,
} from './repo-wallet-credentials-test-fixtures.ts';

type Input = Parameters<typeof credential>[0];

export async function googleSecret(issuerId: string): Promise<SourceCredentials> {
  const identity = await createFixtureIdentity();
  return {
    provider: 'google',
    credentials: {
      issuerId,
      serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
      privateKeyPem: identity.privateKey,
      scopes: [GOOGLE_WALLET_SCOPE],
    },
  };
}

export async function samsungSecret(
  partnerId: string,
  cardId: string,
  identity?: Awaited<ReturnType<typeof createFixtureIdentity>>,
): Promise<SourceCredentials> {
  const id = identity ?? (await createFixtureIdentity());
  return {
    provider: 'samsung',
    credentials: {
      partnerId,
      certificateId: 'ABCD',
      cardId,
      partnerPrivateKeyPem: id.privateKey,
      partnerCertificatePem: id.certificate,
      samsungCertificatePem: id.certificate,
    },
  };
}

export const cardMapOf = async (cardId: string) =>
  JSON.stringify({ generic: await sha256Hex(cardId) });

/** Appends a version holding `secret` with a rotate event and moves the pointer; the version id comes back. */
export async function addRealVersion(
  env: AppEnv,
  c: Cred,
  secret: SourceCredentials,
  cardMap = '{}',
): Promise<string> {
  const row = await first<{ org_id: string | null; scope: string; mode: string; provider: string }>(
    db(),
    'SELECT org_id, scope, mode, provider FROM wallet_credentials WHERE id = ?',
    [c.id],
  );
  if (!row) throw new Error('Missing credential');
  const versionId = uid();
  const envelope = await encryptSecret(
    await loadKekRing(env),
    JSON.stringify({ version: 1, provider: secret.provider, credentials: secret.credentials }),
    credentialAad(
      versionId,
      row.org_id,
      `wallet-credential:${c.id}:${row.scope}:${row.mode}:${row.provider}`,
    ),
  );
  const revision = (await credentialRevision(c.id)) + 1;
  await batch(db(), [
    stmt(
      db(),
      `INSERT INTO wallet_credential_versions (id, credential_id, identity_hash, card_map, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        versionId,
        c.id,
        c.identity,
        cardMap,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
      ],
    ),
    stmt(
      db(),
      `INSERT INTO wallet_credential_events (id, credential_id, revision, kind, version_id, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, 'rotate', ?, 'system', NULL, ?)`,
      [uid(), c.id, revision, versionId, Date.now()],
    ),
    stmt(db(), 'UPDATE wallet_credentials SET revision = ?, current_version_id = ? WHERE id = ?', [
      revision,
      versionId,
      c.id,
    ]),
  ]);
  return versionId;
}

/** A credential whose current version holds `secret` (its identity is the secret's). */
export async function realCredential(
  env: AppEnv,
  o: Input,
  secret: SourceCredentials,
  cardMap = '{}',
): Promise<Cred & { currentId: string }> {
  const c = await credential({ ...o, identity: await credentialIdentityHash(secret) });
  return { ...c, currentId: await addRealVersion(env, c, secret, cardMap) };
}
