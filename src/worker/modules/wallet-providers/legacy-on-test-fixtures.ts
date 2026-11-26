// Since 0229 only an enrolment that is On issues. The old configure route's envelope issued with no enrolment, and
// many tests still issue through one; they turn it On here. Production never reaches this state (an enable needs
// a source, a fresh check and, in Live, a Test round trip), so the enable rules are lifted for the one update.
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { randomBytes, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type StoredCredentials, storedIdentityHash } from './account-credential-material.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  revokeWalletProviderAccount,
} from './account-service.ts';

const ENABLE_RULES = [
  'wallet_enrolments_step',
  'wallet_enrolments_enable_source',
  'wallet_enrolments_enable_check',
  'wallet_enrolments_enable_round_trip',
];

/** Turns a legacy envelope account On, as if enabled; a no-op when it already is. */
export async function legacyOn(db: D1Database, accountId: string | null): Promise<void> {
  if (!accountId) throw new Error('No legacy account to turn on.');
  const set = async () => {
    await run(
      db,
      'UPDATE wallet_provider_accounts SET enabled_at = 1 WHERE id = ? AND enabled_at IS NULL',
      [accountId],
    );
  };
  await ENABLE_RULES.reduceRight<() => Promise<void>>(
    (next, name) => () => withoutTrigger(db, name, next),
    set,
  )();
}

/**
 * A legacy account at revision 1 (the row, its v1 envelope, the configure event, then the pointer), as the old
 * configure route wrote it. That route refuses new accounts and a trigger refuses the pointer, so both are bypassed
 * here: only tests about the legacy model (rotation, key rewrap, migration) or about code that still reads an
 * envelope need one. A test about issuing uses a real enrolment.
 */
export async function seedLegacyAccount(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: Parameters<typeof configureWalletProviderAccount>[2],
): Promise<{ accountId: string }> {
  if (auth?.kind !== 'session') throw new Error('A session is needed to seed a legacy account.');
  const db = ctx.env.DB;
  const accountId = ctx.ids.id();
  const credentialId = ctx.ids.id();
  const stored = {
    version: 1,
    provider: input.provider,
    credentials: input.credentials,
    ...(input.provider === 'google' ? { objectIdHmacKey: toBase64Url(randomBytes(32)) } : {}),
  } as StoredCredentials;
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    JSON.stringify(stored),
    credentialAad(
      credentialId,
      input.orgId,
      `wallet-provider:${accountId}:${input.mode}:${input.provider}`,
    ),
  );
  await ensureCredentialRefKeyset(db, ctx.env);
  const identityHash = await storedIdentityHash(stored);
  const now = ctx.clock.now();
  const at = [accountId, input.orgId, input.mode, input.provider] as const;
  await withoutTrigger(db, 'wallet_provider_accounts_no_new_legacy_update', () =>
    batch(db, [
      stmt(
        db,
        'INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [...at, now, now],
      ),
      stmt(
        db,
        `INSERT INTO wallet_provider_credentials
         (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, identity_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          credentialId,
          ...at,
          envelope.kekVersion,
          envelope.iv,
          envelope.wrappedDek,
          envelope.ciphertext,
          identityHash,
          now,
        ],
      ),
      stmt(
        db,
        `INSERT INTO wallet_provider_account_events
         (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 'configure', ?, ?, ?)`,
        [ctx.ids.id(), ...at, credentialId, auth.userId, now],
      ),
      stmt(
        db,
        'UPDATE wallet_provider_accounts SET credential_id = ?, revision = 1, updated_at = ? WHERE id = ?',
        [credentialId, now, accountId],
      ),
    ]),
  );
  return { accountId };
}

/**
 * A legacy account that issues, as before 0229: configured (a new one is seeded, a rotation goes through the real
 * route), then On. Production has no such account: the route refuses it and an enable needs a source.
 */
export async function configureOn(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: Parameters<typeof configureWalletProviderAccount>[2],
): ReturnType<typeof configureWalletProviderAccount> {
  const scope = { orgId: input.orgId, mode: input.mode, provider: input.provider };
  const existing = await first<{ id: string }>(
    ctx.env.DB,
    'SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = ?',
    [scope.orgId, scope.mode, scope.provider],
  );
  let ready: Awaited<ReturnType<typeof configureWalletProviderAccount>>;
  if (existing?.id) ready = await configureWalletProviderAccount(ctx, auth, input);
  else {
    await seedLegacyAccount(ctx, auth, input);
    ready = await getWalletProviderReadiness(ctx, scope);
  }
  await legacyOn(ctx.env.DB, ready.accountId);
  return ready;
}

/** Back Off, as a legacy account always is in production; its revoke needs that (0112 transition rule). */
export async function legacyOff(db: D1Database, accountId: string): Promise<void> {
  await withoutTrigger(db, 'wallet_enrolments_step', async () => {
    await run(db, 'UPDATE wallet_provider_accounts SET enabled_at = NULL WHERE id = ?', [
      accountId,
    ]);
  });
}

/** `revokeWalletProviderAccount` of an account `configureOn` turned On: Off first, then the revoke. */
export async function revokeOff(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: Parameters<typeof revokeWalletProviderAccount>[2],
): ReturnType<typeof revokeWalletProviderAccount> {
  const row = await first<{ id: string }>(
    ctx.env.DB,
    'SELECT id FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = ?',
    [input.orgId, input.mode, input.provider],
  );
  if (row) await legacyOff(ctx.env.DB, row.id);
  return revokeWalletProviderAccount(ctx, auth, input);
}
