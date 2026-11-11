import { all, first } from '../../platform/db.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow } from './repo-map.ts';
import { readMode, type ScopeArg, scopeOrg } from './scope.ts';

/** Null scope = platform-wide. A pass outside the scope (org, or an API key's mode) reads as missing. */
export async function getPass(
  db: D1Database,
  id: string,
  scope: ScopeArg = null,
): Promise<Pass | null> {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?) AND deleted_at IS NULL AND test_data_quarantined = 0`,
    [id, orgScope, orgScope, mode, mode],
  );
  return row ? mapPass(row) : null;
}

export async function getPassByDownloadToken(db: D1Database, token: string): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE download_token = ? AND deleted_at IS NULL AND test_data_quarantined = 0`,
    [token],
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

export async function listBlockedUsers(
  db: D1Database,
  passId: string,
): Promise<{ id: string; name: string | null }[]> {
  return all<{ id: string; name: string | null }>(
    db,
    `SELECT u.id, COALESCE(u.name, u.primary_email) AS name FROM pass_attach_blocks b
     JOIN users u ON u.id = b.user_id WHERE b.pass_id = ? ORDER BY b.created_at`,
    [passId],
  );
}

export async function getOwnerLabel(
  db: D1Database,
  userId: string,
): Promise<{ name: string | null; email: string | null }> {
  const row = await first<{ name: string | null; email: string | null }>(
    db,
    'SELECT name, primary_email AS email FROM users WHERE id = ?',
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
