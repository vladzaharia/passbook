import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import {
  type IdentityResolver,
  intermediatePem,
  PLATFORM_IDENTITY_ID,
  type ResolvedIdentity,
  readEnvIdentity,
} from './env-identity.ts';
import {
  getCredentialBlob,
  getDefaultRow,
  getIdentityRow,
  type IdentityRow,
  orgDefaultIdentityId,
} from './repo.ts';

// Decrypted key PEMs per isolate, keyed by credential and certificate fingerprint.
// signManifest keeps its own non-extractable CryptoKey cache on top of this.
const keyCache = new Map<string, Promise<string>>();

export function clearIdentityKeyCache(): void {
  keyCache.clear();
}

const notFound = () => new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');

export function apnsBindingPresent(env: AppEnv, binding: string | null): boolean {
  return binding !== null && Boolean((env as unknown as Record<string, unknown>)[binding]);
}

/** Decrypts the private key PEM of a DB identity. Throws if the credential is missing or unreadable. */
export async function loadIdentityKey(env: AppEnv, row: IdentityRow): Promise<string> {
  if (!row.credential_id) throw notFound();
  const cacheKey = `${row.credential_id}:${row.cert_sha256}`;
  let pending = keyCache.get(cacheKey);
  if (!pending) {
    const credentialId = row.credential_id;
    pending = (async () => {
      const blob = await getCredentialBlob(env.DB, credentialId);
      if (!blob) throw notFound();
      try {
        return await decryptSecretText(
          await loadKekRing(env),
          {
            kekVersion: blob.kek_version,
            iv: new Uint8Array(blob.iv),
            wrappedDek: new Uint8Array(blob.wrapped_dek),
            ciphertext: new Uint8Array(blob.ciphertext),
          },
          credentialAad(credentialId, row.org_id, 'pass_signer'),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new UnavailableError(
          'The signing key cannot be decrypted.',
          'IDENTITY_KEY_UNREADABLE',
        );
      }
    })();
    keyCache.set(cacheKey, pending);
    pending.catch(() => keyCache.delete(cacheKey));
  }
  return pending;
}

export async function resolveRow(env: AppEnv, row: IdentityRow): Promise<ResolvedIdentity> {
  if (row.source === 'env') {
    if (row.id !== PLATFORM_IDENTITY_ID)
      throw new NotFoundError('Signing identity is not configured.', 'IDENTITY_NOT_CONFIGURED');
    return { ...readEnvIdentity(env), label: row.label, nfcEnabled: row.nfc_enabled === 1 };
  }
  if (!row.cert_pem) throw notFound();
  return {
    id: row.id,
    orgId: row.org_id,
    label: row.label,
    passTypeIdentifier: row.pass_type_identifier,
    teamIdentifier: row.team_identifier,
    nfcEnabled: row.nfc_enabled === 1,
    apnsBinding: apnsBindingPresent(env, row.apns_binding) ? row.apns_binding : null,
    material: {
      certificate: row.cert_pem,
      privateKey: await loadIdentityKey(env, row),
      intermediate: intermediatePem(env),
    },
  };
}

export function createDbIdentityResolver(env: AppEnv): IdentityResolver {
  const platform = async () => {
    const row = await getIdentityRow(env.DB, PLATFORM_IDENTITY_ID);
    return row ? resolveRow(env, row) : readEnvIdentity(env);
  };

  const byId = async (id: string): Promise<ResolvedIdentity> => {
    if (id === PLATFORM_IDENTITY_ID) return platform();
    const row = await getIdentityRow(env.DB, id);
    if (!row) throw notFound();
    return resolveRow(env, row);
  };

  return {
    platform,
    byId,
    async forOrg(orgId, identityId) {
      const explicit = identityId ?? (await orgDefaultIdentityId(env.DB, orgId));
      if (explicit) {
        const identity = await byId(explicit);
        // An org may use its own identities and global ones, never another org's.
        if (identity.orgId !== null && identity.orgId !== orgId) throw notFound();
        return identity;
      }
      const fallback = await getDefaultRow(env.DB);
      if (fallback && (fallback.org_id === null || fallback.org_id === orgId))
        return resolveRow(env, fallback);
      return platform();
    },
  };
}
