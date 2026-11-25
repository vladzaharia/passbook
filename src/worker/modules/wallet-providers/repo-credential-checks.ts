import { jobGrant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { SourceVersionRow } from './repo-account-source.ts';

export interface CheckTarget extends SourceVersionRow {
  revision: number;
  verified_at: number | null;
}

/** The active credential's current version, with what a verify needs. Revoked or versionless: null. */
export function findCheckTarget(db: D1Database, credentialId: string): Promise<CheckTarget | null> {
  return first<CheckTarget>(
    db,
    `SELECT v.id AS version_id, v.credential_id, v.identity_hash AS version_identity, v.card_map,
      v.kek_version, v.iv, v.wrapped_dek, v.ciphertext, c.scope, c.org_id AS credential_org_id, c.mode,
      c.provider, c.identity_hash AS credential_identity, c.revoked_at, c.revision, c.verified_at
    FROM wallet_credentials c
    JOIN wallet_credential_versions v ON v.id = c.current_version_id AND v.credential_id = c.id
    WHERE c.id = ? AND c.revoked_at IS NULL`,
    [credentialId],
  );
}

/** Active credentials with a version, after `after` by id: one page of the daily check's work list. */
export function listCheckableCredentials(
  db: D1Database,
  after: string,
  limit: number,
): Promise<{ id: string; current_version_id: string }[]> {
  return all<{ id: string; current_version_id: string }>(
    db,
    `SELECT id, current_version_id FROM wallet_credentials
    WHERE revoked_at IS NULL AND current_version_id IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
    [after, limit],
  );
}

export interface CheckRow {
  id: string;
  ok: number;
  code: string | null;
  checked_at: number;
}

/** A check of this credential by id; a check id of another credential reads as absent. */
export function findCheck(
  db: D1Database,
  credentialId: string,
  checkId: string,
): Promise<CheckRow | null> {
  return first<CheckRow>(
    db,
    'SELECT id, ok, code, checked_at FROM wallet_credential_checks WHERE credential_id = ? AND id = ?',
    [credentialId, checkId],
  );
}

export interface CheckWrite {
  checkId: string;
  eventId: string;
  target: CheckTarget;
  ok: boolean;
  code: string | null;
  /** An org-scope credential's first successful check also verifies it. */
  verify: boolean;
}

/**
 * The check row and, for a first success on an org credential, the verify event and `verified_at` in one
 * batch under the check job's grant: the database refuses a check from any other writer.
 */
export async function writeCheck(ctx: ServiceContext, w: CheckWrite): Promise<void> {
  const now = ctx.clock.now();
  const revision = w.target.revision + 1;
  const g = jobGrant(ctx, {
    purpose: 'platform.job.wallet.credential_check',
    job: 'wallet-credential-check',
    tables: ['wallet_credential_checks', 'wallet_credentials', 'wallet_credential_events'],
    codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
    checks: w.verify
      ? [epochIs('wallet_credentials', w.target.credential_id, 'revision', w.target.revision)]
      : [],
  });
  g.insertJoined('wallet_credential_checks', {
    parents: { credential_id: w.target.credential_id },
    columns: ['id', 'version_id', 'ok', 'code'],
    values: [w.checkId, w.target.version_id, w.ok ? 1 : 0, w.code],
  });
  if (w.verify) {
    g.insertJoined('wallet_credential_events', {
      parents: { credential_id: w.target.credential_id },
      columns: [
        'id',
        'revision',
        'kind',
        'version_id',
        'actor_type',
        'actor_id',
        'request_id',
        'created_at',
      ],
      values: [w.eventId, revision, 'verify', null, 'system', null, ctx.requestId, now],
    });
    g.update('wallet_credentials', {
      set: { revision, verified_at: now, updated_at: now },
      where: { id: w.target.credential_id },
    });
  }
  await g.commit();
}

export interface LatestCheck {
  id: string;
  org_id: string | null;
  scope: 'platform' | 'org';
  mode: 'live' | 'test';
  provider: 'google' | 'samsung';
  current_version_id: string;
  check_version_id: string | null;
  ok: number | null;
  code: string | null;
  checked_at: number | null;
}

/** Each active credential with its newest check, for the status rows. */
export function latestChecks(db: D1Database): Promise<LatestCheck[]> {
  return all<LatestCheck>(
    db,
    `SELECT c.id, c.org_id, c.scope, c.mode, c.provider, c.current_version_id,
      k.version_id AS check_version_id, k.ok, k.code, k.checked_at
    FROM wallet_credentials c
    LEFT JOIN wallet_credential_checks k ON k.id = (SELECT k2.id FROM wallet_credential_checks k2
      WHERE k2.credential_id = c.id ORDER BY k2.checked_at DESC, k2.rowid DESC LIMIT 1)
    WHERE c.revoked_at IS NULL AND c.current_version_id IS NOT NULL
    ORDER BY c.id LIMIT 500`,
  );
}

export interface CredentialLastCheck {
  credential_id: string;
  ok: number;
  code: string | null;
  checked_at: number;
}

/**
 * The newest check of each credential's current version; a credential without one has no row. Scoped
 * here to the org, or to the platform's credentials for a null org, whatever ids the caller passes.
 */
export function lastChecksOf(
  db: D1Database,
  orgId: string | null,
  ids: string[],
): Promise<CredentialLastCheck[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return all<CredentialLastCheck>(
    db,
    `SELECT c.id AS credential_id, k.ok, k.code, k.checked_at
    FROM wallet_credentials c
    JOIN wallet_credential_checks k ON k.id = (SELECT k2.id FROM wallet_credential_checks k2
      WHERE k2.credential_id = c.id AND k2.version_id = c.current_version_id
      ORDER BY k2.checked_at DESC, k2.rowid DESC LIMIT 1)
    WHERE c.id IN (${ids.map(() => '?').join(', ')})
      AND ${orgId === null ? "c.scope = 'platform' AND c.org_id IS NULL" : 'c.org_id = ?'}`,
    orgId === null ? ids : [...ids, orgId],
  );
}
