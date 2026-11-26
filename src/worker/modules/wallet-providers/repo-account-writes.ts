import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { grant } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { Envelope } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

type AccountAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

const ACCOUNT_TABLES = [
  'wallet_provider_accounts',
  'wallet_provider_credentials',
  'wallet_provider_account_events',
];
const ACCOUNT = 'wallet_provider_accounts';

/** The grant of one account write: the member, the capability they were checked for, the org and mode. */
function accountGrant(
  ctx: ServiceContext,
  authority: AccountAuthority,
  scope: WalletProviderScope,
  purpose: string,
) {
  if (authority.orgId !== scope.orgId || authority.mode !== scope.mode) return null;
  return grant(ctx, {
    purpose,
    principal: tenantPrincipal(authority),
    checks: capabilityChecks(authority),
    tables: ACCOUNT_TABLES,
  });
}

/** One grant batch: the optional account row, the credential, the event and the CAS update. Each part is tied to the grant. */
export async function saveAccountConfiguration(
  ctx: ServiceContext,
  authority: AccountAuthority,
  scope: WalletProviderScope,
  input: {
    accountId: string;
    expectedRevision: number;
    credentialId: string;
    /** `storedIdentityHash` of the new credential; the account epoch moves when it differs from the old one. */
    identityHash: string;
    eventId: string;
    envelope: Envelope;
  },
): Promise<boolean> {
  const g = accountGrant(ctx, authority, scope, 'org_mode.wallet.account_configure');
  if (!g) return false;
  const now = ctx.clock.now();
  const legacyAt = `a.id = ? AND a.org_id = {org} AND a.mode = {mode} AND a.provider = ?
      AND a.revision = ? AND a.credential_source_id IS NULL AND a.enrolment_revision = 0`;
  const at = [input.accountId, scope.provider, input.expectedRevision];
  g.include(
    writePart(
      `INSERT INTO wallet_provider_credentials
      (id, account_id, org_id, mode, provider, kek_version, iv, wrapped_dek, ciphertext, identity_hash, created_at)
      SELECT ?, a.id, {org}, {mode}, a.provider, ?, ?, ?, ?, ?, ?
      FROM ${ACCOUNT} a WHERE ${legacyAt} AND {grant}`,
      [
        input.credentialId,
        input.envelope.kekVersion,
        input.envelope.iv,
        input.envelope.wrappedDek,
        input.envelope.ciphertext,
        input.identityHash,
        now,
        ...at,
      ],
    ),
    writePart(
      `INSERT INTO wallet_provider_account_events
      (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, request_id, created_at)
      SELECT ?, a.id, {org}, {mode}, a.provider, a.revision + 1, 'configure', ?, ?, ?, ?
      FROM ${ACCOUNT} a WHERE ${legacyAt}
        AND EXISTS (SELECT 1 FROM wallet_provider_credentials c
          WHERE c.id = ? AND c.account_id = a.id AND c.org_id = {org} AND c.mode = {mode} AND c.provider = a.provider)
        AND {grant}`,
      [input.eventId, input.credentialId, authority.userId, null, now, ...at, input.credentialId],
    ),
    writePart(
      `UPDATE ${ACCOUNT} SET credential_id = ?, revoked_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND org_id = {org} AND mode = {mode} AND provider = ? AND revision = ?
        AND credential_source_id IS NULL AND enrolment_revision = 0
        AND EXISTS (SELECT 1 FROM wallet_provider_account_events e WHERE e.id = ? AND e.account_id = ${ACCOUNT}.id
          AND e.revision = ${ACCOUNT}.revision + 1 AND e.kind = 'configure' AND e.credential_id = ?)
        AND {grant} RETURNING id`,
      [input.credentialId, now, ...at, input.eventId, input.credentialId],
    ),
  );
  const results = await g.commit();
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
  },
): Promise<boolean> {
  const g = accountGrant(ctx, authority, scope, 'org_mode.wallet.account_revoke');
  if (!g) return false;
  const now = ctx.clock.now();
  const condition = (a: string) => `${a}.revoked_at IS NULL AND ${a}.credential_source_id IS NULL
    AND ${a}.enrolment_revision = 0 AND NOT EXISTS (SELECT 1 FROM wallet_provider_instances i
      WHERE i.account_id = ${a}.id AND i.lifecycle != 'retired')`;
  g.include(
    writePart(
      `INSERT INTO wallet_provider_account_events
      (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, request_id, created_at)
      SELECT ?, a.id, {org}, {mode}, a.provider, a.revision + 1, ?, a.credential_id, ?, ?, ?
      FROM ${ACCOUNT} a WHERE a.id = ? AND a.org_id = {org} AND a.mode = {mode} AND a.provider = ?
        AND a.revision = ? AND a.credential_id = ? AND ${condition('a')} AND {grant}`,
      [
        input.eventId,
        input.kind,
        authority.userId,
        null,
        now,
        input.accountId,
        scope.provider,
        input.expectedRevision,
        input.credentialId,
      ],
    ),
    writePart(
      `UPDATE ${ACCOUNT} SET revoked_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND org_id = {org} AND mode = {mode} AND provider = ? AND revision = ?
        AND credential_id = ? AND ${condition(ACCOUNT)}
        AND EXISTS (SELECT 1 FROM wallet_provider_account_events e WHERE e.id = ? AND e.account_id = ${ACCOUNT}.id
          AND e.revision = ${ACCOUNT}.revision + 1 AND e.kind = ? AND e.credential_id = ${ACCOUNT}.credential_id)
        AND {grant} RETURNING id`,
      [
        now,
        now,
        input.accountId,
        scope.provider,
        input.expectedRevision,
        input.credentialId,
        input.eventId,
        input.kind,
      ],
    ),
  );
  const results = await g.commit();
  return (results[1]?.results?.length ?? 0) === 1;
}
