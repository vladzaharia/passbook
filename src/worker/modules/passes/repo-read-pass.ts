import { tokenKeys } from '../../platform/capability-token.ts';
import { all, first, stmt } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow } from './repo-map.ts';
import { readMode, type ScopeArg, scopeOrg } from './scope.ts';

/** Null scope = platform-wide. A pass outside the scope (org, or an API key's mode) reads as missing. */
export function getPassStmt(db: D1Database, id: string, scope: ScopeArg = null) {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  return stmt(
    db,
    `${PASS_SELECT} WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?) AND deleted_at IS NULL AND test_data_quarantined = 0`,
    [id, orgScope, orgScope, mode, mode],
  );
}

/** The pass a `getPassStmt` returned in a batch. */
export function passFromResult(result: D1Result | undefined): Pass | null {
  const row = result?.results?.[0] as PassDbRow | undefined;
  return row ? mapPass(row) : null;
}

/** A credential transfer is under way: one row when it is. */
export function transferPendingStmt(db: D1Database, passId: string) {
  return stmt(
    db,
    "SELECT 1 AS n FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
    [passId],
  );
}

export async function getPass(
  db: D1Database,
  id: string,
  scope: ScopeArg = null,
): Promise<Pass | null> {
  const row = await getPassStmt(db, id, scope).first<PassDbRow>();
  return row ? mapPass(row) : null;
}

export async function getPassByDownloadToken(
  env: { DB: D1Database },
  token: string,
): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    env.DB,
    `${PASS_SELECT} WHERE download_token IN (?, ?, ?) AND deleted_at IS NULL AND test_data_quarantined = 0`,
    await tokenKeys(env, 'pass', token),
  );
  return row ? mapPass(row) : null;
}

/** Includes soft-deleted passes: devices still receive the voided pass until the retention purge. */
export async function getPassBySerial(
  db: D1Database,
  identityId: string,
  serial: string,
): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE identity_id = ? AND serial = ? AND test_data_quarantined = 0`,
    [identityId, serial],
  );
  return row ? mapPass(row) : null;
}

/** Latest recorded pass.json. Metadata-only edits bump `version` without a new row, so no exact match. */
export async function currentPassJson(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ pass_json: string | null }>(
    db,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return row?.pass_json ?? null;
}

/** Users blocked from attaching, labelled for the caller (see `userLabelSql`). */
export async function listBlockedUsers(
  db: D1Database,
  passId: string,
  platform: boolean,
): Promise<{ id: string; name: string | null }[]> {
  return all<{ id: string; name: string | null }>(
    db,
    `SELECT b.user_id AS id, ${userLabelSql('b.user_id', '(SELECT org_id FROM passes WHERE id = b.pass_id)', platform)} AS name
     FROM pass_attach_blocks b WHERE b.pass_id = ? ORDER BY b.created_at`,
    [passId],
  );
}

export async function getOwnerLabel(
  db: D1Database,
  userId: string,
): Promise<{ name: string | null; email: string | null }> {
  const row = await first<{ name: string | null; email: string | null }>(
    db,
    `SELECT name, ${knownEmailSql('primary_email')} AS email FROM users WHERE id = ?`,
    [userId],
  );
  return row ?? { name: null, email: null };
}

export async function countRegistrations(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
    [passId],
  );
  return row?.n ?? 0;
}

/** Newest push row that has not started, for flushing before a delete. */
export async function pendingPushId(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' AND state IN ('pending', 'enqueued')
     ORDER BY created_at DESC LIMIT 1`,
    [passId],
  );
  return row?.id ?? null;
}
