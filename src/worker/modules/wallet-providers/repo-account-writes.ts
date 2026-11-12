import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { batch, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { accountCredentialLineageSql } from './repo-account-lineage.ts';

type AccountAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

/** Conditional statements share a transaction; RETURNING excludes audit/dirty trigger changes. */
export async function saveAccountConfiguration(
  ctx: ServiceContext,
  authority: AccountAuthority,
  scope: WalletProviderScope,
  input: {
    accountId: string;
    isNew: boolean;
    expectedRevision: number;
    credentialId: string;
    eventId: string;
    envelope: Envelope;
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  const { DB: db } = ctx.env;
  const now = ctx.clock.now();
  const guard = tenantPassAuthoritySql(authority, 'a');
  const params = tenantPassAuthorityParams(authority, now);
  const statements: D1PreparedStatement[] = [];
  if (input.isNew) {
    statements.push(
      stmt(
        db,
        `INSERT INTO wallet_provider_accounts
      (id, org_id, mode, provider, revision, created_at, updated_at)
      SELECT ?, ?, ?, ?, 0, ?, ? WHERE ${tenantPassAuthoritySql(authority)} AND ${credentialRefKeysetSql}
      ON CONFLICT(org_id, mode, provider) DO NOTHING`,
        [
          input.accountId,
          scope.orgId,
          scope.mode,
          scope.provider,
          now,
          now,
          ...params,
          input.credentialKeysetCommitment,
        ],
      ),
    );
  }
  statements.push(
    stmt(
      db,
      `INSERT INTO wallet_provider_credentials
    (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, created_at)
    SELECT ?, a.id, a.org_id, a.mode, a.provider, ?, ?, ?, ?, ?
    FROM wallet_provider_accounts a WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ?
      AND a.revision = ? AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql} AND ${guard}`,
      [
        input.credentialId,
        input.envelope.kekVersion,
        input.envelope.iv,
        input.envelope.wrappedDek,
        input.envelope.ciphertext,
        now,
        input.accountId,
        scope.orgId,
        scope.mode,
        scope.provider,
        input.expectedRevision,
        input.credentialKeysetCommitment,
        ...params,
      ],
    ),
  );
  statements.push(
    stmt(
      db,
      `INSERT INTO wallet_provider_account_events
    (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, request_id, created_at)
    SELECT ?, a.id, a.org_id, a.mode, a.provider, a.revision + 1, 'configure', ?, ?, ?, ?
    FROM wallet_provider_accounts a WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ?
      AND a.revision = ? AND EXISTS (SELECT 1 FROM wallet_provider_credentials c
        WHERE c.id = ? AND c.account_id = a.id AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider)
      AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql} AND ${guard}`,
      [
        input.eventId,
        input.credentialId,
        authority.userId,
        null,
        now,
        input.accountId,
        scope.orgId,
        scope.mode,
        scope.provider,
        input.expectedRevision,
        input.credentialId,
        input.credentialKeysetCommitment,
        ...params,
      ],
    ),
  );
  statements.push(
    stmt(
      db,
      `UPDATE wallet_provider_accounts AS a SET credential_id = ?,
      revoked_at = NULL, revision = revision + 1, updated_at = ?
    WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ? AND a.revision = ?
      AND EXISTS (SELECT 1 FROM wallet_provider_account_events e WHERE e.id = ? AND e.account_id = a.id
        AND e.revision = a.revision + 1 AND e.kind = 'configure' AND e.credential_id = ?)
      AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql} AND ${guard} RETURNING id`,
      [
        input.credentialId,
        now,
        input.accountId,
        scope.orgId,
        scope.mode,
        scope.provider,
        input.expectedRevision,
        input.eventId,
        input.credentialId,
        input.credentialKeysetCommitment,
        ...params,
      ],
    ),
  );
  const results = await batch(db, statements);
  return (results[results.length - 1]?.results?.length ?? 0) === 1;
}

export async function transitionAccount(
  ctx: ServiceContext,
  authority: AccountAuthority,
  scope: WalletProviderScope,
  input: {
    accountId: string;
    credentialId: string;
    expectedRevision: number;
    eventId: string;
    kind: 'revoke';
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const guard = tenantPassAuthoritySql(authority, 'a');
  const params = tenantPassAuthorityParams(authority, now);
  const condition = `a.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances i
        WHERE i.account_id = a.id AND i.lifecycle != 'retired')`;
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_provider_account_events
      (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, request_id, created_at)
      SELECT ?, a.id, a.org_id, a.mode, a.provider, a.revision + 1, ?, a.credential_id, ?, ?, ?
      FROM wallet_provider_accounts a WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ?
        AND a.revision = ? AND a.credential_id = ? AND ${condition}
        AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql} AND ${guard}`,
      [
        input.eventId,
        input.kind,
        authority.userId,
        null,
        now,
        input.accountId,
        scope.orgId,
        scope.mode,
        scope.provider,
        input.expectedRevision,
        input.credentialId,
        input.credentialKeysetCommitment,
        ...params,
      ],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_accounts AS a SET
        revoked_at = ?, revision = revision + 1, updated_at = ?
      WHERE a.id = ? AND a.org_id = ? AND a.mode = ? AND a.provider = ? AND a.revision = ?
        AND a.credential_id = ? AND ${condition}
        AND EXISTS (SELECT 1 FROM wallet_provider_account_events e WHERE e.id = ? AND e.account_id = a.id
          AND e.revision = a.revision + 1 AND e.kind = ? AND e.credential_id = a.credential_id)
        AND ${credentialRefKeysetSql} AND ${accountCredentialLineageSql} AND ${guard} RETURNING id`,
      [
        now,
        now,
        input.accountId,
        scope.orgId,
        scope.mode,
        scope.provider,
        input.expectedRevision,
        input.credentialId,
        input.eventId,
        input.kind,
        input.credentialKeysetCommitment,
        ...params,
      ],
    ),
  ]);
  return (results[1]?.results?.length ?? 0) === 1;
}
