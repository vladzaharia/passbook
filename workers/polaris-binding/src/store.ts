import type { AccountClass, Health, SignupKind, Target } from './types.ts';

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

export async function subjectClass(db: D1Database, subject: string): Promise<AccountClass | null> {
  const row = await db
    .prepare('SELECT class FROM idp_subjects WHERE subject = ?')
    .bind(subject)
    .first<{ class: AccountClass }>();
  return row?.class ?? null;
}

export async function liveGrants(db: D1Database, subject: string): Promise<Target[]> {
  const { results } = await db
    .prepare('SELECT target AS role FROM idp_grants WHERE subject = ? AND removed_at IS NULL')
    .bind(subject)
    .all<{ role: Target }>();
  return results.map((r) => r.role);
}

/** Subjects with a confirmed grant made at or before `by`. Pending and newer grants are not for a snapshot to end. */
export async function grantsOfRole(db: D1Database, role: Target, by: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      'SELECT subject FROM idp_grants WHERE target = ? AND removed_at IS NULL AND confirmed_at IS NOT NULL AND confirmed_at <= ?',
    )
    .bind(role, by)
    .all<{ subject: string }>();
  return results.map((r) => r.subject);
}

/** Recorded before the write, pending until it is read back: a lost answer must not leave a role PassBook cannot take back. */
export async function recordAdded(
  db: D1Database,
  subject: string,
  roles: Target[],
  ref: string,
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO idp_subjects (subject, class, created_at) VALUES (?, 'linked', ?)
         ON CONFLICT (subject) DO UPDATE SET class = CASE WHEN class = 'external' THEN 'linked' ELSE class END`,
      )
      .bind(subject, at),
    ...roles.map((role) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO idp_grants (subject, target, source, ref, created_at) VALUES (?, ?, 'added', ?, ?)",
        )
        .bind(subject, role, ref, at),
    ),
  ]);
}

/** Everyone with a live grant for the role, pending ones included. */
export async function liveGrantSubjects(db: D1Database, role: Target): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT subject FROM idp_grants WHERE target = ? AND removed_at IS NULL')
    .bind(role)
    .all<{ subject: string }>();
  return results.map((r) => r.subject);
}

/** The write was read back: the grants are real. */
export async function confirmGrants(
  db: D1Database,
  subject: string,
  roles: Target[],
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          'UPDATE idp_grants SET confirmed_at = ? WHERE subject = ? AND target = ? AND removed_at IS NULL AND confirmed_at IS NULL',
        )
        .bind(at, subject, role),
    ),
  );
}

/** Grants a snapshot ended because the member left the group, since `since`. */
export async function endedSince(
  db: D1Database,
  since: number,
): Promise<{ subject: string; role: Target }[]> {
  const { results } = await db
    .prepare(
      "SELECT subject, target AS role FROM idp_grants WHERE removed_reason = 'idp_removed' AND removed_at >= ? ORDER BY id",
    )
    .bind(since)
    .all<{ subject: string; role: Target }>();
  return results;
}

/** The account was seen enabled, so a disable mark of the binding's is stale. */
export async function clearDisabledMarks(db: D1Database, subjects: string[]): Promise<void> {
  if (!subjects.length) return;
  await db
    .prepare(
      `UPDATE idp_subjects SET disabled_by_binding_at = NULL WHERE disabled_by_binding_at IS NOT NULL AND subject IN (${subjects.map(() => '?').join(',')})`,
    )
    .bind(...subjects)
    .run();
}

export async function endGrants(
  db: D1Database,
  subject: string,
  roles: Target[],
  reason: string,
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          'UPDATE idp_grants SET removed_at = ?, removed_reason = ? WHERE subject = ? AND target = ? AND removed_at IS NULL',
        )
        .bind(at, reason, subject, role),
    ),
  );
}

/** An override removal of a role the binding never added: a spent row, so the ledger of grants shows it. */
export async function recordOverride(
  db: D1Database,
  subject: string,
  roles: Target[],
  ref: string,
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          `INSERT INTO idp_grants (subject, target, source, ref, created_at, removed_at, removed_reason)
           VALUES (?, ?, 'override', ?, ?, ?, 'override')`,
        )
        .bind(subject, role, ref, at, at),
    ),
  );
}

export async function noteExternal(db: D1Database, subject: string, at: number): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO idp_subjects (subject, class, created_at) VALUES (?, 'external', ?)",
    )
    .bind(subject, at)
    .run();
}

export async function markDisabled(
  db: D1Database,
  subject: string,
  at: number | null,
): Promise<void> {
  await db
    .prepare('UPDATE idp_subjects SET disabled_by_binding_at = ? WHERE subject = ?')
    .bind(at, subject)
    .run();
}

export async function disabledByBinding(db: D1Database, subject: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT disabled_by_binding_at AS at FROM idp_subjects WHERE subject = ?')
    .bind(subject)
    .first<{ at: number | null }>();
  return row?.at != null;
}

export type HealthCore = Omit<Health, 'budget' | 'layout' | 'ok' | 'mode' | 'frozen'> & {
  keySubject: string | null;
};

export async function readHealth(db: D1Database): Promise<HealthCore | null> {
  const row = await db
    .prepare(
      `SELECT checked_at AS checkedAt, unsafe, warnings, groups, key_subject AS keySubject,
              key_expires_at AS keyExpiresAt, layout_suspect AS suspect FROM idp_health WHERE id = 1`,
    )
    .first<{
      checkedAt: number;
      unsafe: string;
      warnings: string;
      groups: string;
      keySubject: string | null;
      keyExpiresAt: number | null;
      suspect: number;
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
  };
}

export async function writeHealth(db: D1Database, h: HealthCore): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idp_health (id, checked_at, unsafe, warnings, groups, key_subject, key_expires_at, layout_suspect)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET checked_at = ?1, unsafe = ?2, warnings = ?3, groups = ?4,
         key_subject = ?5, key_expires_at = ?6, layout_suspect = ?7`,
    )
    .bind(
      h.checkedAt,
      JSON.stringify(h.unsafe),
      JSON.stringify(h.warnings),
      JSON.stringify(h.groups),
      h.keySubject,
      h.keyExpiresAt,
      h.layoutSuspect ? 1 : 0,
    )
    .run();
}

export interface GroupRow {
  key: string;
  kind: 'role' | 'custom' | 'adopted';
  state: 'pending' | 'live' | 'abandoned' | 'deleting' | 'deleted';
  groupId: string | null;
  name: string;
  createdByBinding: boolean;
  createdAt: number;
}

const GROUP = `key, kind, state, group_id AS groupId, name, created_by_binding AS createdByBinding, created_at AS createdAt`;

export async function listGroupRows(db: D1Database): Promise<GroupRow[]> {
  const { results } = await db
    .prepare(`SELECT ${GROUP} FROM idp_groups ORDER BY created_at, key`)
    .all<Omit<GroupRow, 'createdByBinding'> & { createdByBinding: number }>();
  return results.map((r) => ({ ...r, createdByBinding: r.createdByBinding === 1 }));
}

/** The intent, written before the POST. */
export async function insertIntent(
  db: D1Database,
  row: { key: string; kind: 'role' | 'custom'; name: string; ref: string; at: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO idp_groups (key, kind, state, name, created_by_binding, ref, created_at) VALUES (?, ?, 'pending', ?, 1, ?, ?)",
    )
    .bind(row.key, row.kind, row.name, row.ref, row.at)
    .run();
}

export async function setGroupLive(db: D1Database, key: string, groupId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE idp_groups SET state = 'live', group_id = ? WHERE key = ? AND state = 'pending'",
    )
    .bind(groupId, key)
    .run();
}

export async function abandonIntent(db: D1Database, key: string): Promise<void> {
  await db
    .prepare("UPDATE idp_groups SET state = 'abandoned' WHERE key = ? AND state = 'pending'")
    .bind(key)
    .run();
}

export async function setGroupDeleting(db: D1Database, key: string): Promise<void> {
  await db
    .prepare("UPDATE idp_groups SET state = 'deleting' WHERE key = ? AND state = 'live'")
    .bind(key)
    .run();
}

export async function setGroupDeleted(db: D1Database, key: string, at: number): Promise<void> {
  await db
    .prepare(
      "UPDATE idp_groups SET state = 'deleted', deleted_at = ? WHERE key = ? AND state = 'deleting'",
    )
    .bind(at, key)
    .run();
}

/** First sight of an adopted group: its live name is recorded once. */
export async function recordAdopted(
  db: D1Database,
  key: string,
  groupId: string,
  name: string,
  at: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO idp_groups (key, kind, state, group_id, name, created_by_binding, created_at) VALUES (?, 'adopted', 'live', ?, ?, 0, ?)",
    )
    .bind(key, groupId, name, at)
    .run();
}
