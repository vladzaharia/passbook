import {
  type GoogleWalletCredentials,
  GoogleWalletCredentialsSchema,
  type SamsungWalletCredentials,
  SamsungWalletCredentialsSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import {
  credentialAad,
  decryptSecretText,
  isKeyEnvName,
  loadKekRing,
} from '../../platform/crypto.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { fromBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { accountHmacKind } from '../keys/rewrap-tables.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import type { AccountRow } from './repo-accounts.ts';

/** Server-only material. Never serialize this value into an API response, audit record or log. */
export type WalletProviderCredentialSnapshot = { credentialKeysetCommitment: string } & (
  | {
      accountId: string;
      revision: number;
      provider: 'google';
      credentials: GoogleWalletCredentials;
      objectIdHmacKey: Uint8Array;
      /** The source version the secret came from; NULL for a legacy envelope's own secret. */
      credentialVersionId: string | null;
    }
  | {
      accountId: string;
      revision: number;
      provider: 'samsung';
      credentials: SamsungWalletCredentials;
    }
);

export type StoredCredentials =
  | {
      version: 1;
      provider: 'google';
      credentials: GoogleWalletCredentials;
      objectIdHmacKey: string;
      credentialVersionId?: string;
    }
  | { version: 1; provider: 'samsung'; credentials: SamsungWalletCredentials };

/** An enrolment with its own key and no legacy envelope: the provider secret comes from its source alone. */
export type KeyOnlyAccount =
  | { version: 1; provider: 'google'; credentials: null; objectIdHmacKey: string }
  | { version: 1; provider: 'samsung'; credentials: null };

export const corrupt = () =>
  new UnavailableError(
    'Wallet provider credentials are unavailable.',
    'WALLET_CREDENTIALS_UNAVAILABLE',
  );

/** Pin all KEK versions once before any asynchronous account or provider work. */
export function snapshotWalletCredentialContext(ctx: ServiceContext): ServiceContext {
  const keyEnv = captureCredentialKeyEnv(ctx.env);
  const env = { ...ctx.env };
  for (const name of Object.keys(env)) {
    if (isKeyEnvName(name)) delete (env as unknown as Record<string, unknown>)[name];
  }
  return { ...ctx, env: { ...env, ...keyEnv } };
}

export async function assertCredentialKeyset(
  ctx: ServiceContext,
  credentialKeysetCommitment: string,
): Promise<void> {
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment)
    throw corrupt();
}

function aad(
  row: Pick<AccountRow, 'id' | 'org_id' | 'mode' | 'provider' | 'credential_id'>,
): string {
  if (!row.credential_id) throw corrupt();
  return credentialAad(
    row.credential_id,
    row.org_id,
    `wallet-provider:${row.id}:${row.mode}:${row.provider}`,
  );
}

function bytes(value: number[] | Uint8Array | ArrayBuffer | null): Uint8Array {
  if (value === null) throw corrupt();
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
}

/** Decrypts only the exact account's current scoped envelope, including for revoked-account rotation. */
export async function decryptAccount(
  ctx: ServiceContext,
  row: AccountRow,
): Promise<StoredCredentials> {
  if (row.kek_version === null) throw corrupt();
  try {
    const text = await decryptSecretText(
      await loadKekRing(ctx.env),
      {
        kekVersion: row.kek_version,
        iv: bytes(row.iv),
        wrappedDek: bytes(row.wrapped_dek),
        ciphertext: bytes(row.ciphertext),
      },
      aad(row),
    );
    const decoded: unknown = JSON.parse(text);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw corrupt();
    const stored = decoded as Record<string, unknown>;
    if (stored.version !== 1 || stored.provider !== row.provider) throw corrupt();
    if (stored.provider === 'google') {
      const parsed = GoogleWalletCredentialsSchema.safeParse(stored.credentials);
      if (
        !parsed.success ||
        typeof stored.objectIdHmacKey !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(stored.objectIdHmacKey) ||
        fromBase64Url(stored.objectIdHmacKey).length !== 32
      )
        throw corrupt();
      return {
        version: 1,
        provider: 'google',
        credentials: parsed.data,
        objectIdHmacKey: stored.objectIdHmacKey,
      };
    }
    const parsed = SamsungWalletCredentialsSchema.safeParse(stored.credentials);
    if (!parsed.success) throw corrupt();
    return { version: 1, provider: 'samsung', credentials: parsed.data };
  } catch {
    // Do not expose crypto, parsing, or plaintext details through errors or logs.
    throw corrupt();
  }
}

const HMAC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** The enrolment's own HMAC key, or null when the row has none yet (a legacy row). */
async function decryptOwnKey(ctx: ServiceContext, row: AccountRow): Promise<string | null> {
  if (row.hmac_ciphertext === null || row.hmac_ciphertext === undefined) return null;
  if (row.hmac_kek_version == null) throw corrupt();
  try {
    const key = await decryptSecretText(
      await loadKekRing(ctx.env),
      {
        kekVersion: row.hmac_kek_version,
        iv: bytes(row.hmac_iv ?? null),
        wrappedDek: bytes(row.hmac_wrapped_dek ?? null),
        ciphertext: bytes(row.hmac_ciphertext),
      },
      credentialAad(row.id, row.org_id, accountHmacKind(row.id, row.mode, row.provider)),
    );
    if (!HMAC_KEY.test(key) || fromBase64Url(key).length !== 32) throw corrupt();
    return key;
  } catch {
    throw corrupt();
  }
}

/**
 * What the runtime reads: the enrolment's own key first, then the legacy envelope. A row with no legacy
 * envelope must have its own key. Samsung has no key; its own-key column is ignored.
 */
export async function openAccount(
  ctx: ServiceContext,
  row: AccountRow,
): Promise<StoredCredentials | KeyOnlyAccount> {
  const own = row.provider === 'google' ? await decryptOwnKey(ctx, row) : null;
  if (row.kek_version === null) {
    if (row.provider === 'samsung') {
      if (row.hmac_ciphertext == null) throw corrupt();
      return { version: 1, provider: 'samsung', credentials: null };
    }
    if (own === null) throw corrupt();
    return { version: 1, provider: 'google', credentials: null, objectIdHmacKey: own };
  }
  const legacy = await decryptAccount(ctx, row);
  return own !== null && legacy.provider === 'google'
    ? { ...legacy, objectIdHmacKey: own }
    : legacy;
}

export function credentialSnapshot(
  row: AccountRow,
  stored: StoredCredentials,
  credentialKeysetCommitment: string,
): WalletProviderCredentialSnapshot {
  if (stored.provider === 'google')
    return {
      accountId: row.id,
      revision: row.revision,
      credentialKeysetCommitment,
      provider: 'google',
      credentials: stored.credentials,
      objectIdHmacKey: fromBase64Url(stored.objectIdHmacKey),
      credentialVersionId: stored.credentialVersionId ?? null,
    };
  return {
    accountId: row.id,
    revision: row.revision,
    credentialKeysetCommitment,
    provider: 'samsung',
    credentials: stored.credentials,
  };
}
