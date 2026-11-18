import { derivedHmacKey, isKeyEnvName } from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { toHex } from '../../platform/ids.ts';
import { EVIDENCE_ROOT } from '../../platform/mac-key-config.ts';
import { macRootVersions } from '../../platform/mac-roots.ts';
import {
  initializeCredentialRefKeyset,
  initializeKeysetWith,
  matchesCredentialRefKeyset,
} from './repo-credential-keyset.ts';

const encoder = new TextEncoder();

/** Pin the complete KEK ring before asynchronous commitment and reference derivation. */
export function captureCredentialKeyEnv(env: object): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isKeyEnvName(name) && typeof value === 'string') snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

/** Commit to the same derived key that scopes retired credential references. */
export async function credentialRefKeysetCommitment(env: object): Promise<string> {
  let key: CryptoKey;
  try {
    key = await derivedHmacKey(env, 'pass-credential-tombstone-v1');
  } catch {
    // Some KEK is set but root 1 is not (removed, no MAC_ROOT_V1): the commitment cannot match, which is
    // the keyset's own refusal. No key at all is a configuration fault.
    throw macRootVersions(env).length > 0 && !macRootVersions(env).includes(EVIDENCE_ROOT)
      ? unavailable()
      : new UnavailableError(
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

/** `ensureCredentialRefKeyset` that also runs `extra` statements in its trip. */
export async function ensureCredentialRefKeysetWith(
  db: D1Database,
  env: object,
  extra: D1PreparedStatement[],
): Promise<{ commitment: string; extra: D1Result[] }> {
  const commitment = await credentialRefKeysetCommitment(env);
  const done = await initializeKeysetWith(db, commitment, extra);
  if (!done.ok) throw unavailable();
  return { commitment, extra: done.extra };
}

/** Revalidate retained authority without ever initializing a missing singleton. */
export async function requireCredentialRefKeyset(db: D1Database, env: object): Promise<string> {
  const commitment = await credentialRefKeysetCommitment(env);
  if (!(await matchesCredentialRefKeyset(db, commitment))) throw unavailable();
  return commitment;
}
