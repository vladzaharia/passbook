import { all, first, run } from '../../platform/db.ts';
import { mapPass, type Pass, type PassDbRow } from '../passes/repo-map.ts';

export interface CapturedRow {
  id: string;
  org_id: string;
  pass_id: string | null;
  bundle_id: string | null;
  outbox_id: string | null;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  attached: number;
  created_at: number;
}

export type NewCaptured = Omit<CapturedRow, 'attached' | 'pass_id' | 'bundle_id' | 'outbox_id'> & {
  pass_id?: string | null;
  bundle_id?: string | null;
  outbox_id?: string | null;
  attached?: boolean;
};

export async function insertCaptured(db: D1Database, row: NewCaptured): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO captured_emails
       (id, org_id, pass_id, bundle_id, outbox_id, recipient, subject, html, text, attached, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.org_id,
      row.pass_id ?? null,
      row.bundle_id ?? null,
      row.outbox_id ?? null,
      row.recipient,
      row.subject,
      row.html,
      row.text,
      row.attached ? 1 : 0,
      row.created_at,
    ],
  );
}

export interface CapturedFilter {
  orgId?: string | undefined;
  /** Exclusive: the last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

const SUMMARY = `id, org_id, pass_id, bundle_id, outbox_id, recipient, subject, '' AS html, '' AS text,
  attached, created_at`;

/** Newest first. Ids are UUIDv7, so id order is time order. */
export function listCaptured(db: D1Database, f: CapturedFilter): Promise<CapturedRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.orgId) {
    where.push('org_id = ?');
    params.push(f.orgId);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  return all<CapturedRow>(
    db,
    `SELECT ${SUMMARY} FROM captured_emails ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
}

export const getCaptured = (db: D1Database, id: string) =>
  first<CapturedRow>(db, 'SELECT * FROM captured_emails WHERE id = ?', [id]);

export async function deleteCapturedBefore(
  db: D1Database,
  before: number,
  limit: number,
): Promise<number> {
  const { changes } = await run(
    db,
    `DELETE FROM captured_emails WHERE id IN (
       SELECT id FROM captured_emails WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
    [before, limit],
  );
  return changes;
}

/** The oldest test bundles past the cutoff. */
export function expiredTestBundles(
  db: D1Database,
  before: number,
  limit: number,
): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    "SELECT id FROM bundles WHERE mode = 'test' AND created_at < ? ORDER BY created_at LIMIT ?",
    [before, limit],
  );
}

export async function deleteBundlesByIds(db: D1Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { changes } = await run(
    db,
    `DELETE FROM bundles WHERE mode = 'test' AND id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return changes;
}

/** The oldest test passes past the cutoff, served by passes_test_age. Removed ones included. */
export async function expiredTestPasses(
  db: D1Database,
  before: number,
  limit: number,
): Promise<Pass[]> {
  const rows = await all<PassDbRow>(
    db,
    "SELECT * FROM passes WHERE mode = 'test' AND created_at < ? ORDER BY created_at LIMIT ?",
    [before, limit],
  );
  return rows.map(mapPass);
}

/** The signed-in user's own verified address: the primary one when verified, else any. */
export async function verifiedEmailOf(db: D1Database, userId: string): Promise<string | null> {
  const row = await first<{ email: string }>(
    db,
    `SELECT e.email FROM users u JOIN user_emails e ON e.user_id = u.id
     WHERE u.id = ? AND u.status = 'active'
     ORDER BY (e.email = u.primary_email) DESC, e.verified_at LIMIT 1`,
    [userId],
  );
  return row?.email ?? null;
}
