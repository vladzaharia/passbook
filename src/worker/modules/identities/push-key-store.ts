import { credentialAad, decryptSecret, loadKekRing } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/log.ts';
import { importSigningKey } from './push-key.ts';
import { getPushKeyMeta, getPushKeyRow } from './repo-push-keys.ts';

export interface PushKey {
  keyId: string;
  key: CryptoKey;
}

export const pushKeyAad = (id: string, team: string) => credentialAad(id, null, `apns_key:${team}`);

// Imported non-extractable keys per isolate, by row id. A replaced key gets a new id.
const keys = new Map<string, PushKey>();

export function clearPushKeyCache(): void {
  keys.clear();
}

export async function teamHasPushKey(env: AppEnv, team: string): Promise<boolean> {
  return team !== '' && (await getPushKeyMeta(env.DB, team)) !== null;
}

/** The team's signing key, or null when none is stored. Throws when it cannot be decrypted. */
export async function loadPushKey(env: AppEnv, team: string): Promise<PushKey | null> {
  if (team === '') return null;
  const row = await getPushKeyRow(env.DB, team);
  if (!row) return null;
  const cached = keys.get(row.id);
  if (cached) return cached;
  try {
    const der = await decryptSecret(
      await loadKekRing(env),
      {
        kekVersion: row.kek_version,
        iv: new Uint8Array(row.iv),
        wrappedDek: new Uint8Array(row.wrapped_dek),
        ciphertext: new Uint8Array(row.ciphertext),
      },
      pushKeyAad(row.id, team),
    );
    const loaded = { keyId: row.key_id, key: await importSigningKey(der) };
    keys.set(row.id, loaded);
    return loaded;
  } catch (error) {
    createLogger({ build: env.CF_VERSION?.id }).error('push_key.decrypt_failed', {
      code: 'PUSH_KEY_UNREADABLE',
      team,
      error,
    });
    throw new UnavailableError('The push key cannot be decrypted.', 'PUSH_KEY_UNREADABLE');
  }
}
