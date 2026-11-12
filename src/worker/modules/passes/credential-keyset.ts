import { derivedHmacKey } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { toHex } from '../../platform/ids.ts';
import {
  initializeCredentialRefKeyset,
  matchesCredentialRefKeyset,
} from './repo-credential-keyset.ts';

const encoder = new TextEncoder();

/** Pin the complete KEK ring before asynchronous commitment and reference derivation. */
export function captureCredentialKeyEnv(env: object): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^KEK_V\d+$/.test(name) && typeof value === 'string') snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

/** Commit to the same derived key that scopes retired credential references. */
export async function credentialRefKeysetCommitment(env: object): Promise<string> {
  let key: CryptoKey;
  try {
    key = await derivedHmacKey(env, 'pass-credential-tombstone-v1');
  } catch {
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_CONFIG_UNAVAILABLE',
    );
  }
  const message = encoder.encode('pass-credential-ref-keyset-v1');
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

function unavailable(): UnavailableError {
  return new UnavailableError(
    'Credential references are unavailable.',
    'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
  );
}

/** Initialize only on an empty ref store; the guarded insert and validation share a transaction. */
export async function ensureCredentialRefKeyset(db: D1Database, env: object): Promise<string> {
  const commitment = await credentialRefKeysetCommitment(env);
  if (!(await initializeCredentialRefKeyset(db, commitment))) throw unavailable();
  return commitment;
}

/** Revalidate retained authority without ever initializing a missing singleton. */
export async function requireCredentialRefKeyset(db: D1Database, env: object): Promise<string> {
  const commitment = await credentialRefKeysetCommitment(env);
  if (!(await matchesCredentialRefKeyset(db, commitment))) throw unavailable();
  return commitment;
}
