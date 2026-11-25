import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { writePart } from '../../platform/authority-include.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AccountRow } from './repo-accounts.ts';
import { mapWalletWriteError } from './wallet-write-errors.ts';

type Mode = 'live' | 'test';
type Provider = 'google' | 'samsung';

/** Accounts on the legacy envelope with no source: not retired, org not deleted. */
const PENDING = `a.credential_id IS NOT NULL AND a.credential_source_id IS NULL AND a.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id AND o.status != 'deleted')`;

export interface PendingAccount {
  id: string;
  org_id: string;
  mode: Mode;
  provider: Provider;
}

/** The next page of pending accounts after `after` (an account id), in id order; `scope` narrows to one mode and provider. */
export function pendingAccounts(
  db: D1Database,
  after: string,
  limit: number,
  scope?: { mode: Mode; provider: Provider },
): Promise<PendingAccount[]> {
  return all<PendingAccount>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider FROM wallet_provider_accounts a
     WHERE ${PENDING} AND a.id > ?${scope ? ' AND a.mode = ? AND a.provider = ?' : ''}
     ORDER BY a.id LIMIT ?`,
    [after, ...(scope ? [scope.mode, scope.provider] : []), limit],
  );
}

export async function countAccounts(
  db: D1Database,
): Promise<{ pending: number; migrated: number }> {
  const row = await first<{ pending: number; migrated: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN ${PENDING} THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN a.credential_id IS NOT NULL AND a.credential_source_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS migrated
     FROM wallet_provider_accounts a`,
  );
  return { pending: row?.pending ?? 0, migrated: row?.migrated ?? 0 };
}

/** An account that is pending migration now (the job re-reads it; a rerun finds it gone). */
export function findPending(db: D1Database, id: string): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, a.revision, a.credential_id, a.credential_source_id, a.revoked_at, a.updated_at,
       c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
     FROM wallet_provider_accounts a
     JOIN wallet_provider_credentials c ON c.id = a.credential_id AND c.account_id = a.id
       AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
     WHERE a.id = ? AND ${PENDING}`,
    [id],
  );
}

/** The legacy envelope row of an account by scope, pending or not (a resolution reads the one it names). */
export function findLegacy(
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
): Promise<AccountRow | null> {
  return first<AccountRow>(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, a.revision, a.credential_id, a.credential_source_id, a.revoked_at, a.updated_at,
       c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
     FROM wallet_provider_accounts a
     JOIN wallet_provider_credentials c ON c.id = a.credential_id AND c.account_id = a.id
       AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
     WHERE a.org_id = ? AND a.mode = ? AND a.provider = ?`,
    [orgId, mode, provider],
  );
}

/** An org credential someone relies on: verified, or the source of a legacy account. A bare claim is neither. */
const PROVEN = `(x.verified_at IS NOT NULL OR EXISTS (SELECT 1 FROM wallet_provider_accounts p
  WHERE p.credential_source_id = x.id AND p.credential_id IS NOT NULL))`;

async function otherOrgs(
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
  identityHash: string,
  proven: boolean,
): Promise<{ org_id: string }[]> {
  return all<{ org_id: string }>(
    db,
    `SELECT x.org_id FROM wallet_credentials x WHERE x.scope = 'org' AND x.revoked_at IS NULL
       AND x.mode = ? AND x.provider = ? AND x.identity_hash = ? AND x.org_id != ?
       AND ${proven ? '' : 'NOT '}${PROVEN} ORDER BY x.org_id`,
    [mode, provider, identityHash, orgId],
  );
}

/** Another org's active, proven org-scope credential with this identity: it refuses the migration. */
export const rivalOrgs = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
  identityHash: string,
) => otherOrgs(db, orgId, mode, provider, identityHash, true);

/** Unproven claims of the identity (unverified, no legacy account on them): reported, never blocking. */
export const unprovenOrgs = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  provider: Provider,
  identityHash: string,
) => otherOrgs(db, orgId, mode, provider, identityHash, false);

/** The refusal in the grant itself, so two accounts migrating at once cannot both create the identity. */
export const noRivalCredential = (
  orgId: string,
  mode: Mode,
  provider: Provider,
  identityHash: string,
): Check => ({
  reason: 'config',
  ok: (b) =>
    `NOT EXISTS (SELECT 1 FROM wallet_credentials x WHERE x.scope = 'org' AND x.revoked_at IS NULL
       AND x.mode = ${b.bind(mode)} AND x.provider = ${b.bind(provider)}
       AND x.identity_hash = ${b.bind(identityHash)} AND x.org_id != ${b.bind(orgId)} AND ${PROVEN})`,
});

/** The account is still at the revision the caller read (`revision` legacy, `enrolment_revision` source), not retired. */
export const accountAt = (
  id: string,
  column: 'revision' | 'enrolment_revision',
  value: number,
): Check => ({
  reason: 'config',
  ok: (b) =>
    `EXISTS (SELECT 1 FROM wallet_provider_accounts t WHERE t.id = ${b.bind(id)} AND t.org_id = a.org_id
       AND t.mode = a.mode AND t.revoked_at IS NULL AND t.${column} = ${b.bind(value)})`,
});

/** Accounts pointing at an org-scope credential of this identity, for a merge. */
export function accountsOnOrgIdentity(
  db: D1Database,
  mode: Mode,
  provider: Provider,
  identityHash: string,
): Promise<{ id: string; org_id: string; credential_source_id: string }[]> {
  return all(
    db,
    `SELECT a.id, a.org_id, a.credential_source_id FROM wallet_provider_accounts a
     JOIN wallet_credentials c ON c.id = a.credential_source_id AND c.scope = 'org'
     WHERE a.mode = ? AND a.provider = ? AND a.revoked_at IS NULL AND a.credential_id IS NOT NULL
       AND c.revoked_at IS NULL AND c.identity_hash = ?`,
    [mode, provider, identityHash],
  );
}

/**
 * Retires a legacy account: its `revoke` event at the next legacy revision, then `revoked_at`. The 0112
 * transition trigger needs the event, an Off enrolment and no unretired instance.
 */
export async function retireLegacy(
  ctx: ServiceContext,
  g: Grant,
  row: { id: string; revision: number },
  actorId: string,
): Promise<void> {
  const now = ctx.clock.now();
  g.include(
    writePart(
      `INSERT INTO wallet_provider_account_events
         (id, account_id, org_id, mode, provider, revision, kind, credential_id, actor_id, request_id, created_at)
       SELECT ?, a.id, {org}, {mode}, a.provider, a.revision + 1, 'revoke', a.credential_id, ?, ?, ?
       FROM wallet_provider_accounts a
       WHERE a.id = ? AND a.org_id = {org} AND a.mode = {mode} AND a.revision = ? AND a.revoked_at IS NULL AND {grant}`,
      [ctx.ids.id(), actorId, ctx.requestId, now, row.id, row.revision],
    ),
    writePart(
      `UPDATE wallet_provider_accounts SET revoked_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND org_id = {org} AND mode = {mode} AND revision = ? AND revoked_at IS NULL AND {grant}`,
      [now, now, row.id, row.revision],
    ),
  );
  try {
    await g.commit();
  } catch (error) {
    throw mapWalletWriteError(error);
  }
}
