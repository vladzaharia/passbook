import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError, ConflictError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
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
const keyCache = new Map<string, string>();

export function clearIdentityKeyCache(): void {
  keyCache.clear();
}

const notFound = () => new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');

export function apnsBindingPresent(env: AppEnv, binding: string | null): boolean {
  if (binding === null) return false;
  const value = (env as unknown as Record<string, { fetch?: unknown } | undefined>)[binding];
  return typeof value?.fetch === 'function';
}

/** Decrypts the private key PEM of a DB identity. Throws if the credential is missing or unreadable. */
export async function loadIdentityKey(env: AppEnv, row: IdentityRow): Promise<string> {
  if (!row.credential_id) throw notFound();
  const cacheKey = `${row.credential_id}:${row.cert_sha256}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const credentialId = row.credential_id;
  const blob = await getCredentialBlob(env.DB, credentialId);
  if (!blob) throw notFound();
  let pem: string;
  try {
    pem = await decryptSecretText(
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
    throw new UnavailableError('The signing key cannot be decrypted.', 'IDENTITY_KEY_UNREADABLE');
  }
  // Settled values only: a promise created in one request cannot be awaited from another.
  keyCache.set(cacheKey, pem);
  return pem;
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

/** New passes only: an identity that stopped issuing or whose certificate ended signs nothing new. */
async function assertIssuable(env: AppEnv, id: string, now: number): Promise<void> {
  const row = await getIdentityRow(env.DB, id);
  if (!row) return;
  if (row.issuing === 0)
    throw new ConflictError('This signing identity no longer issues passes.', 'IDENTITY_RETIRED');
  if (row.not_after !== null && row.not_after <= now)
    throw new ConflictError(
      'The signing certificate has expired. Renew it before issuing passes.',
      'IDENTITY_EXPIRED',
    );
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
    byRow: (row) => resolveRow(env, row),
    async forOrg(orgId, identityId, now) {
      const explicit = identityId ?? (await orgDefaultIdentityId(env.DB, orgId));
      if (explicit) {
        const identity = await byId(explicit);
        // An org may use its own identities and global ones, never another org's.
        if (identity.orgId !== null && identity.orgId !== orgId) throw notFound();
        await assertIssuable(env, identity.id, now);
        return identity;
      }
      const fallback = await getDefaultRow(env.DB);
      if (fallback && (fallback.org_id === null || fallback.org_id === orgId)) {
        const identity = await resolveRow(env, fallback);
        await assertIssuable(env, identity.id, now);
        return identity;
      }
      const identity = await platform();
      await assertIssuable(env, identity.id, now);
      return identity;
    },
  };
}
