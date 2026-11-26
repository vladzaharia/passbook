// Legacy (v1 envelope) accounts for the migration tests, seeded as the old configure route wrote them.
import { env } from 'cloudflare:workers';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import { randomBytes, toBase64Url } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { googleObjectIds } from './google-ids.ts';
import type { Kit } from './wallet-wa1b-test-fixtures.ts';

export type Provider = 'google' | 'samsung';

export interface Seeded {
  id: string;
  orgId: string;
  mode: Mode;
  provider: Provider;
  /** The Google HMAC key of the v1 envelope. */
  hmacKey: string | null;
}

let configurer = '';
/** An account at legacy revision 1: the row, its v1 envelope, the configure event, then the pointer. */
export async function seedLegacy(
  k: Kit,
  orgId: string,
  mode: Mode,
  provider: Provider,
  credentials: unknown,
): Promise<Seeded> {
  configurer ||= (await k.admin()).user.id;
  const id = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const hmacKey = provider === 'google' ? toBase64Url(randomBytes(32)) : null;
  const e = await encryptSecret(
    await loadKekRing(k.env),
    JSON.stringify({
      version: 1,
      provider,
      credentials,
      ...(hmacKey ? { objectIdHmacKey: hmacKey } : {}),
    }),
    credentialAad(credentialId, orgId, `wallet-provider:${id}:${mode}:${provider}`),
  );
  const now = Date.now();
  // The database refuses a new legacy account (0229); this seed is the old state the migration moves off.
  await withoutTrigger(env.DB, 'wallet_provider_accounts_no_new_legacy_update', () =>
    batch(env.DB, [
      stmt(
        env.DB,
        'INSERT INTO wallet_provider_accounts (id, org_id, mode, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, orgId, mode, provider, now, now],
      ),
      stmt(
        env.DB,
        `INSERT INTO wallet_provider_credentials (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          credentialId,
          id,
          orgId,
          mode,
          provider,
          e.kekVersion,
          e.iv,
          e.wrappedDek,
          e.ciphertext,
          now,
        ],
      ),
      stmt(
        env.DB,
        `INSERT INTO wallet_provider_account_events (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'configure', ?, ?, ?)`,
        [crypto.randomUUID(), id, orgId, mode, provider, credentialId, configurer, now],
      ),
      stmt(
        env.DB,
        'UPDATE wallet_provider_accounts SET credential_id = ?, revision = 1, updated_at = ? WHERE id = ?',
        [credentialId, now, id],
      ),
    ]),
  );
  return { id, orgId, mode, provider, hmacKey };
}

export interface AccountState {
  revision: number;
  enrolment_revision: number;
  credential_source_id: string | null;
  identity_hash: string | null;
  revoked_at: number | null;
  has_hmac: number;
  source_scope: string | null;
}

export const stateOf = (id: string) =>
  first<AccountState>(
    env.DB,
    `SELECT a.revision, a.enrolment_revision, a.credential_source_id, a.identity_hash, a.revoked_at,
       a.hmac_ciphertext IS NOT NULL AS has_hmac, c.scope AS source_scope
     FROM wallet_provider_accounts a LEFT JOIN wallet_credentials c ON c.id = a.credential_source_id
     WHERE a.id = ?`,
    [id],
  ) as Promise<AccountState>;

/** The ids the account's Google objects get, from the issuer and key the runtime resolves now. */
export async function currentIds(k: Kit, a: Seeded) {
  const state = await stateOf(a.id);
  await ensureCredentialRefKeyset(env.DB, k.env);
  const v = await readGoogleCallbackVerification(k.ctx, {
    orgId: a.orgId,
    mode: a.mode,
    accountId: a.id,
    accountRevision: state.revision,
  });
  if (!v) throw new Error('The account does not resolve.');
  return googleObjectIds(v.issuerId, v.objectIdHmacKey, {
    tenantId: a.orgId,
    mode: a.mode,
    releaseId: 'r1',
    passId: 'p1',
    channelEpoch: 1,
    credentialGeneration: 1,
  });
}

/** Rows of the account's org this migration wrote, to show a failed batch left none. */
export const rowsOfOrg = async (orgId: string) => ({
  credentials: (
    await first<{ n: number }>(
      env.DB,
      'SELECT count(*) AS n FROM wallet_credentials WHERE org_id = ?',
      [orgId],
    )
  )?.n,
  versions: (
    await first<{ n: number }>(
      env.DB,
      `SELECT count(*) AS n FROM wallet_credential_versions v JOIN wallet_credentials c ON c.id = v.credential_id WHERE c.org_id = ?`,
      [orgId],
    )
  )?.n,
  events: (
    await first<{ n: number }>(
      env.DB,
      'SELECT count(*) AS n FROM wallet_enrolment_events WHERE org_id = ?',
      [orgId],
    )
  )?.n,
});

/** Pending accounts among `ids` (the gate query, narrowed: the database is shared across a file's cases). */
export async function pendingAmong(ids: string[]): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id FROM wallet_provider_accounts a JOIN orgs o ON o.id = a.org_id AND o.status != 'deleted'
     WHERE a.credential_id IS NOT NULL AND a.credential_source_id IS NULL AND a.revoked_at IS NULL
       AND a.id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}
