import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import { getCredentialBlob, type NewIdentity } from './repo.ts';

/** A pending key is a `pass_signer` credential like any identity key; its fingerprint is the public-key hash. */
export async function sealPendingKey(
  env: AppEnv,
  input: { id: string; orgId: string | null; privateKeyPem: string; pubkeySha256: string },
): Promise<NewIdentity['credential']> {
  const envelope = await encryptSecret(
    await loadKekRing(env),
    input.privateKeyPem,
    credentialAad(input.id, input.orgId, 'pass_signer'),
  );
  return {
    id: input.id,
    orgId: input.orgId,
    kekVersion: envelope.kekVersion,
    iv: envelope.iv,
    wrappedDek: envelope.wrappedDek,
    ciphertext: envelope.ciphertext,
    fingerprint: input.pubkeySha256,
  };
}

export async function openPendingKey(
  env: AppEnv,
  credentialId: string,
  orgId: string | null,
): Promise<string> {
  const blob = await getCredentialBlob(env.DB, credentialId);
  if (!blob) throw new NotFoundError('The pending key is gone.', 'CERT_PENDING_KEY_MISSING');
  try {
    return await decryptSecretText(
      await loadKekRing(env),
      {
        kekVersion: blob.kek_version,
        iv: new Uint8Array(blob.iv),
        wrappedDek: new Uint8Array(blob.wrapped_dek),
        ciphertext: new Uint8Array(blob.ciphertext),
      },
      credentialAad(credentialId, orgId, 'pass_signer'),
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new UnavailableError('The pending key cannot be decrypted.', 'IDENTITY_KEY_UNREADABLE');
  }
}
