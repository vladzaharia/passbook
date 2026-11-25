import type { Health } from './types.ts';

export interface SignupRow {
  tokenId: string;
  tokenSha256: string;
  ref: string;
  createdAt: number;
  expiresAt: number;
  state: 'minted' | 'deleted' | 'used' | 'proven';
  subject: string | null;
}

const SIGNUP = `token_id AS tokenId, token_sha256 AS tokenSha256, ref, created_at AS createdAt,
  expires_at AS expiresAt, state, subject`;

export async function rememberSignup(
  db: D1Database,
  row: Pick<SignupRow, 'tokenId' | 'tokenSha256' | 'ref' | 'createdAt' | 'expiresAt'>,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO idp_signups (token_id, token_sha256, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(row.tokenId, row.tokenSha256, row.ref, row.createdAt, row.expiresAt)
    .run();
}

export async function signupsById(db: D1Database, ids: string[]): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SIGNUP} FROM idp_signups WHERE token_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<SignupRow>();
  return results;
}

export async function setSignupState(
  db: D1Database,
  tokenId: string,
  state: 'deleted' | 'used',
): Promise<void> {
  await db
    .prepare("UPDATE idp_signups SET state = ? WHERE token_id = ? AND state IN ('minted', ?)")
    .bind(state, tokenId, state)
    .run();
}

/** Marks a token proven for `subject` and records the signup grant, in one batch. */
export async function recordProof(
  db: D1Database,
  tokenId: string,
  subject: string,
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE idp_signups SET state = 'proven', subject = ? WHERE token_id = ? AND (subject IS NULL OR subject = ?)",
      )
      .bind(subject, tokenId, subject),
    db
      .prepare(
        "INSERT OR IGNORE INTO idp_grants (subject, source, token_id, created_at) VALUES (?, 'signup', ?, ?)",
      )
      .bind(subject, tokenId, at),
  ]);
}

export async function liveGrant(db: D1Database, subject: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM idp_grants WHERE subject = ? AND removed_at IS NULL')
    .bind(subject)
    .first();
  return row !== null;
}

export async function recordAdded(db: D1Database, subject: string, at: number): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO idp_grants (subject, source, created_at) VALUES (?, 'added', ?)",
    )
    .bind(subject, at)
    .run();
}

export async function endGrant(db: D1Database, subject: string, at: number): Promise<void> {
  await db
    .prepare('UPDATE idp_grants SET removed_at = ? WHERE subject = ? AND removed_at IS NULL')
    .bind(at, subject)
    .run();
}

type HealthCore = Omit<Health, 'budget' | 'layout' | 'ok'>;

export async function readHealth(db: D1Database): Promise<HealthCore | null> {
  const row = await db
    .prepare(
      'SELECT checked_at AS checkedAt, unsafe, group_name AS groupName, key_expires_at AS keyExpiresAt, layout_suspect AS suspect FROM idp_health WHERE id = 1',
    )
    .first<{
      checkedAt: number;
      unsafe: string;
      groupName: string | null;
      keyExpiresAt: number | null;
      suspect: number;
    }>();
  if (!row) return null;
  return {
    checkedAt: row.checkedAt,
    unsafe: JSON.parse(row.unsafe) as string[],
    groupName: row.groupName,
    keyExpiresAt: row.keyExpiresAt,
    layoutSuspect: row.suspect === 1,
  };
}

export async function writeHealth(db: D1Database, h: HealthCore): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idp_health (id, checked_at, unsafe, group_name, key_expires_at, layout_suspect)
       VALUES (1, ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET checked_at = ?1, unsafe = ?2, group_name = ?3, key_expires_at = ?4, layout_suspect = ?5`,
    )
    .bind(
      h.checkedAt,
      JSON.stringify(h.unsafe),
      h.groupName,
      h.keyExpiresAt,
      h.layoutSuspect ? 1 : 0,
    )
    .run();
}
