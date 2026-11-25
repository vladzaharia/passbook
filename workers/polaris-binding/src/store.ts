import type { Health, SignupKind, Target } from './types.ts';

export interface SignupRow {
  tokenId: string;
  tokenSha256: string;
  kind: SignupKind;
  targets: Target[];
  ref: string;
  createdAt: number;
  expiresAt: number;
  state: 'minted' | 'deleted' | 'used' | 'proven';
  subject: string | null;
}

const SIGNUP = `token_id AS tokenId, token_sha256 AS tokenSha256, kind, targets, ref, created_at AS createdAt,
  expires_at AS expiresAt, state, subject`;

export async function rememberSignup(
  db: D1Database,
  row: Pick<
    SignupRow,
    'tokenId' | 'tokenSha256' | 'kind' | 'targets' | 'ref' | 'createdAt' | 'expiresAt'
  >,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO idp_signups (token_id, token_sha256, kind, targets, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      row.tokenId,
      row.tokenSha256,
      row.kind,
      JSON.stringify(row.targets),
      row.ref,
      row.createdAt,
      row.expiresAt,
    )
    .run();
}

export async function signupsById(db: D1Database, ids: string[]): Promise<SignupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SIGNUP} FROM idp_signups WHERE token_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<Omit<SignupRow, 'targets'> & { targets: string }>();
  return results.map((r) => ({ ...r, targets: JSON.parse(r.targets) as Target[] }));
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

/** Marks a token proven for `subject`, records the account as created and one signup grant per role the token carried. */
export async function recordProof(
  db: D1Database,
  tokenId: string,
  subject: string,
  roles: Target[],
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
        `INSERT INTO idp_subjects (subject, class, created_at, token_id) VALUES (?, 'created', ?, ?)
         ON CONFLICT (subject) DO UPDATE SET class = 'created', token_id = excluded.token_id`,
      )
      .bind(subject, at, tokenId),
    ...roles.map((role) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO idp_grants (subject, target, source, token_id, created_at, confirmed_at) VALUES (?, ?, 'signup', ?, ?, ?)",
        )
        .bind(subject, role, tokenId, at, at),
    ),
  ]);
}

export type HealthCore = Omit<Health, 'budget' | 'layout' | 'ok' | 'mode' | 'frozen'> & {
  keySubject: string | null;
  /** Targets (`g:<key>`) whose group is renamed, gone or refused: writes to them stop. */
  blocked: string[];
};

export async function readHealth(db: D1Database): Promise<HealthCore | null> {
  const row = await db
    .prepare(
      `SELECT checked_at AS checkedAt, unsafe, warnings, groups, key_subject AS keySubject,
              key_expires_at AS keyExpiresAt, layout_suspect AS suspect, blocked FROM idp_health WHERE id = 1`,
    )
    .first<{
      checkedAt: number;
      unsafe: string;
      warnings: string;
      groups: string;
      keySubject: string | null;
      keyExpiresAt: number | null;
      suspect: number;
      blocked: string;
    }>();
  if (!row) return null;
  return {
    checkedAt: row.checkedAt,
    unsafe: JSON.parse(row.unsafe) as string[],
    warnings: JSON.parse(row.warnings) as string[],
    groups: JSON.parse(row.groups) as HealthCore['groups'],
    keySubject: row.keySubject,
    keyExpiresAt: row.keyExpiresAt,
    layoutSuspect: row.suspect === 1,
    blocked: JSON.parse(row.blocked) as string[],
  };
}

export async function writeHealth(db: D1Database, h: HealthCore): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idp_health (id, checked_at, unsafe, warnings, groups, key_subject, key_expires_at, layout_suspect, blocked)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (id) DO UPDATE SET checked_at = ?1, unsafe = ?2, warnings = ?3, groups = ?4,
         key_subject = ?5, key_expires_at = ?6, layout_suspect = ?7, blocked = ?8`,
    )
    .bind(
      h.checkedAt,
      JSON.stringify(h.unsafe),
      JSON.stringify(h.warnings),
      JSON.stringify(h.groups),
      h.keySubject,
      h.keyExpiresAt,
      h.layoutSuspect ? 1 : 0,
      JSON.stringify(h.blocked),
    )
    .run();
}
