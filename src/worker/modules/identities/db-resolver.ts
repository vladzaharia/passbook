import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError, ConflictError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/log.ts';
import {
  envIdentityPresent,
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

export function platformEnvMismatch(
  identity: Pick<ResolvedIdentity, 'passTypeIdentifier' | 'teamIdentifier'>,
  row: Pick<IdentityRow, 'pass_type_identifier' | 'team_identifier'>,
): boolean {
  return (
    identity.passTypeIdentifier !== row.pass_type_identifier ||
    identity.teamIdentifier !== row.team_identifier
  );
}

// Every refused sign would log; once per 50 per isolate keeps a bad deploy loud but not flooding.
let mismatchRefusals = 0;
export function resetEnvMismatchLog(): void {
  mismatchRefusals = 0;
}
function noteEnvMismatch(identity: ResolvedIdentity, row: IdentityRow): void {
  if (mismatchRefusals++ % 50 !== 0) return;
  createLogger().error('identity.platform_env_mismatch', {
    code: 'IDENTITY_PLATFORM_ENV_MISMATCH',
    identityId: row.id,
    rowPassType: row.pass_type_identifier,
    envPassType: identity.passTypeIdentifier,
  });
}

export async function resolveRow(env: AppEnv, row: IdentityRow): Promise<ResolvedIdentity> {
  if (row.source === 'env') {
    if (row.id !== PLATFORM_IDENTITY_ID)
      throw new NotFoundError('Signing identity is not configured.', 'IDENTITY_NOT_CONFIGURED');
    // The default moved on and the env material was removed: a retired row says so, not "not configured".
    if (row.issuing === 0 && !envIdentityPresent(env)) {
      createLogger().warn('identity.platform_retired', {
        code: 'IDENTITY_RETIRED',
        identityId: row.id,
      });
      throw new ConflictError('This signing identity no longer issues passes.', 'IDENTITY_RETIRED');
    }
    const identity = readEnvIdentity(env);
    // Installed passes key on the row's pass type and team: never sign them as anything else.
    if (platformEnvMismatch(identity, row)) {
      noteEnvMismatch(identity, row);
      throw new UnavailableError(
        'The platform signing identity does not match its configuration.',
        'IDENTITY_PLATFORM_ENV_MISMATCH',
      );
    }
    return { ...identity, label: row.label, nfcEnabled: row.nfc_enabled === 1 };
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

/** Why an identity cannot sign new passes, or null. */
async function refusal(env: AppEnv, id: string, now: number): Promise<ConflictError | null> {
  const row = await getIdentityRow(env.DB, id);
  if (!row) return null;
  if (row.issuing === 0)
    return new ConflictError('This signing identity no longer issues passes.', 'IDENTITY_RETIRED');
  if (row.not_after !== null && row.not_after <= now)
    return new ConflictError(
      'The signing certificate has expired. Renew it before issuing passes.',
      'IDENTITY_EXPIRED',
    );
  return null;
}

/** The identity new platform-owned passes sign with: the default platform row, else the env one. */
export async function resolveDefaultPlatform(env: AppEnv): Promise<ResolvedIdentity> {
  const row = await getDefaultRow(env.DB);
  if (row && row.org_id === null && row.purpose === 'passes') return resolveRow(env, row);
  return createDbIdentityResolver(env).platform();
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

  /** The row an id names, without its key: the legacy id stands for the env identity when it has no row. */
  const peekRow = async (
    id: string,
  ): Promise<{ id: string; orgId: string | null; purpose: string }> => {
    const row = await getIdentityRow(env.DB, id);
    if (row) {
      if (row.source !== 'env' && !row.cert_pem) throw notFound();
      return { id: row.id, orgId: row.org_id, purpose: row.purpose };
    }
    if (id === PLATFORM_IDENTITY_ID && envIdentityPresent(env))
      return { id, orgId: null, purpose: 'passes' };
    throw notFound();
  };

  return {
    platform,
    byId,
    byRow: (row) => resolveRow(env, row),
    async peekById(id) {
      return { id: (await peekRow(id)).id };
    },
    async peekForOrg(orgId, identityId, now) {
      const scoped = async (id: string) => {
        const meta = await peekRow(id);
        if (meta.purpose !== 'passes') throw notFound();
        if (meta.orgId !== null && meta.orgId !== orgId) throw notFound();
        return meta.id;
      };
      if (identityId) {
        const id = await scoped(identityId);
        const refused = await refusal(env, id, now);
        if (refused) throw refused;
        return { id };
      }
      const orgDefault = await orgDefaultIdentityId(env.DB, orgId);
      if (orgDefault) {
        const refused = await refusal(env, orgDefault, now);
        if (!refused) return { id: await scoped(orgDefault) };
        if (refused.code !== 'IDENTITY_RETIRED') {
          await scoped(orgDefault);
          throw refused;
        }
      }
      const fallback = await getDefaultRow(env.DB);
      if (fallback && fallback.purpose !== 'passes') throw notFound();
      if (fallback && (fallback.org_id === null || fallback.org_id === orgId)) {
        if (!(await refusal(env, fallback.id, now))) return { id: (await peekRow(fallback.id)).id };
      }
      const id = (await peekRow(PLATFORM_IDENTITY_ID)).id;
      const refused = await refusal(env, id, now);
      if (refused) throw refused;
      return { id };
    },
    async forOrg(orgId, identityId, now) {
      // An org may use its own identities and global ones, never another org's.
      const scoped = async (id: string) => {
        // A platform-only identity (device test) is no org's to use, named or defaulted: refuse before decrypting.
        const row = id === PLATFORM_IDENTITY_ID ? null : await getIdentityRow(env.DB, id);
        if (row && row.purpose !== 'passes') throw notFound();
        const identity = await byId(id);
        if (identity.orgId !== null && identity.orgId !== orgId) throw notFound();
        return identity;
      };
      // A named identity is refused when it cannot issue; defaults fall through to the next one.
      if (identityId) {
        const identity = await scoped(identityId);
        const refused = await refusal(env, identity.id, now);
        if (refused) throw refused;
        return identity;
      }
      const orgDefault = await orgDefaultIdentityId(env.DB, orgId);
      if (orgDefault) {
        // The refusal comes before the material: a retired legacy row whose env material is gone cannot resolve.
        const refused = await refusal(env, orgDefault, now);
        if (!refused) return scoped(orgDefault);
        // Only a retired default hands over to the next one: a pass never changes identity, so an
        // expired one must refuse instead of quietly issuing under another pass type.
        if (refused.code !== 'IDENTITY_RETIRED') {
          await scoped(orgDefault);
          throw refused;
        }
      }
      const fallback = await getDefaultRow(env.DB);
      if (fallback && fallback.purpose !== 'passes') throw notFound();
      if (fallback && (fallback.org_id === null || fallback.org_id === orgId)) {
        const identity = await resolveRow(env, fallback);
        if (!(await refusal(env, identity.id, now))) return identity;
      }
      const identity = await platform();
      const refused = await refusal(env, identity.id, now);
      if (refused) throw refused;
      return identity;
    },
  };
}
