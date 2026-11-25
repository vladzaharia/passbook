export interface GroupRow {
  key: string;
  kind: 'role' | 'custom' | 'adopted';
  state: 'pending' | 'live' | 'abandoned' | 'deleting' | 'deleted' | 'gone';
  groupId: string | null;
  name: string;
  friendlyName: string | null;
  createdByBinding: boolean;
  createdAt: number;
}

const GROUP = `key, kind, state, group_id AS groupId, name, friendly_name AS friendlyName, created_by_binding AS createdByBinding, created_at AS createdAt`;

export async function listGroupRows(db: D1Database): Promise<GroupRow[]> {
  const { results } = await db
    .prepare(`SELECT ${GROUP} FROM idp_groups ORDER BY created_at, key`)
    .all<Omit<GroupRow, 'createdByBinding'> & { createdByBinding: number }>();
  return results.map((r) => ({ ...r, createdByBinding: r.createdByBinding === 1 }));
}

/** The intent, written before the POST. */
export async function insertIntent(
  db: D1Database,
  row: {
    key: string;
    kind: 'role' | 'custom';
    name: string;
    friendly: string;
    ref: string;
    at: number;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO idp_groups (key, kind, state, name, friendly_name, created_by_binding, ref, created_at) VALUES (?, ?, 'pending', ?, ?, 1, ?, ?)",
    )
    .bind(row.key, row.kind, row.name, row.friendly, row.ref, row.at)
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

/** The owner deleted a custom group the binding made: it drops out of the registry and its key stays used. */
export async function setGroupGone(db: D1Database, key: string): Promise<void> {
  await db
    .prepare("UPDATE idp_groups SET state = 'gone' WHERE key = ? AND state = 'live'")
    .bind(key)
    .run();
}

/** A delete that did not go ahead: the group is live again. */
export async function setGroupLiveAgain(db: D1Database, key: string): Promise<void> {
  await db
    .prepare("UPDATE idp_groups SET state = 'live' WHERE key = ? AND state = 'deleting'")
    .bind(key)
    .run();
}
