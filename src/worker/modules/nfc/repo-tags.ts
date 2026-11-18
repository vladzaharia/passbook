import type { Mode } from '../../../shared/contracts/common.ts';
import type { Tag, TagBinding } from '../../../shared/contracts/nfc-tags.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';

type Db = D1Database;

export interface TagRow {
  id: string;
  orgId: string;
  mode: Mode;
  hint: string;
  label: string | null;
  status: 'active' | 'retired';
}

export interface BindingRow {
  id: string;
  tagId: string;
  scope: 'pass' | 'user';
  passId: string;
  userId: string | null;
  /** The pass's owner now, for telling the same holder from another. */
  passOwnerId: string | null;
  endCause: string | null;
}

export interface PassFacts {
  id: string;
  orgId: string;
  mode: Mode;
  ownerUserId: string | null;
  deletedAt: number | null;
}

const LAST_CAUSE = `(SELECT lb.end_cause FROM tag_bindings lb WHERE lb.tag_id = t.id AND lb.ended_at IS NOT NULL
  ORDER BY lb.ended_at DESC, lb.rowid DESC LIMIT 1)`;

const VIEW = `SELECT t.id, t.mode, t.kind, t.hint, t.label, t.status, t.created_at, t.last_seen_at,
    b.id AS b_id, b.scope AS b_scope, b.pass_id AS b_pass_id, b.user_id AS b_user_id, b.source AS b_source,
    b.bound_at AS b_bound_at, p.display_title AS pass_title, hu.name AS holder_name,
    CASE b.bound_by_type
      WHEN 'user' THEN (SELECT u.name FROM users u WHERE u.id = b.bound_by)
      WHEN 'staff' THEN (SELECT s.name FROM scan_staff s WHERE s.id = b.bound_by AND s.org_id = t.org_id)
      ELSE (SELECT s.name FROM scanners s WHERE s.id = b.bound_by AND s.org_id = t.org_id) END AS bound_by_name,
    (SELECT s.name FROM scanners s WHERE s.id = b.scanner_id AND s.org_id = t.org_id) AS scanner_name,
    ${LAST_CAUSE} AS last_cause
  FROM nfc_tags t INDEXED BY nfc_tags_list
  LEFT JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL
  LEFT JOIN passes p ON p.id = b.pass_id AND p.org_id = t.org_id AND p.mode = t.mode
  LEFT JOIN users hu ON hu.id = b.user_id`;

interface ViewRow {
  id: string;
  mode: Mode;
  kind: 'uid' | 'sun';
  hint: string;
  label: string | null;
  status: 'active' | 'retired';
  created_at: number;
  last_seen_at: number | null;
  b_id: string | null;
  b_scope: 'pass' | 'user' | null;
  b_pass_id: string | null;
  b_user_id: string | null;
  b_source: 'scanner' | 'remote' | 'admin' | null;
  b_bound_at: number | null;
  pass_title: string | null;
  holder_name: string | null;
  bound_by_name: string | null;
  scanner_name: string | null;
  last_cause: string | null;
}

function toTag(r: ViewRow): Tag {
  const binding: TagBinding | null =
    r.b_id && r.b_scope && r.b_pass_id && r.b_source && r.b_bound_at !== null
      ? {
          id: r.b_id,
          tagId: r.id,
          scope: r.b_scope,
          passId: r.b_pass_id,
          passTitle: r.pass_title,
          userId: r.b_user_id,
          holderName: r.b_scope === 'user' ? r.holder_name : null,
          source: r.b_source,
          lent: false,
          boundAt: r.b_bound_at,
          boundByName: r.bound_by_name,
          scannerName: r.scanner_name,
          endedAt: null,
          endCause: null,
        }
      : null;
  const state =
    r.status === 'retired'
      ? 'retired'
      : binding
        ? 'assigned'
        : r.last_cause === 'lost'
          ? 'lost'
          : 'spare';
  return {
    id: r.id,
    mode: r.mode,
    kind: r.kind,
    assurance: r.kind === 'sun' ? 'secure' : 'basic',
    hint: r.hint,
    label: r.label,
    pool: false,
    status: r.status,
    state,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    keysetId: null,
    binding,
  };
}

const STATE_SQL = {
  assigned: "t.status = 'active' AND b.id IS NOT NULL",
  retired: "t.status = 'retired'",
  lost: `t.status = 'active' AND b.id IS NULL AND ${LAST_CAUSE} = 'lost'`,
  spare: `t.status = 'active' AND b.id IS NULL AND COALESCE(${LAST_CAUSE}, '') <> 'lost'`,
  lent: '0',
} as const;

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface TagListFilter {
  orgId: string;
  mode: Mode;
  status?: keyof typeof STATE_SQL | undefined;
  q?: string | undefined;
  /** The last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

/** One page of the org's tags in this mode, newest first. */
export async function listTags(
  db: Db,
  f: TagListFilter,
): Promise<{ items: Tag[]; nextCursor: string | null }> {
  const where = ['t.org_id = ?', 't.mode = ?'];
  const params: SqlValue[] = [f.orgId, f.mode];
  if (f.status) where.push(STATE_SQL[f.status]);
  if (f.q) {
    where.push("(t.label LIKE ? ESCAPE '\\' OR t.hint = ?)");
    params.push(`%${escapeLike(f.q)}%`, f.q.toUpperCase());
  }
  if (f.cursor) {
    where.push('t.id < ?');
    params.push(f.cursor);
  }
  const rows = await all<ViewRow>(
    db,
    `${VIEW} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  return {
    items: page.map(toTag),
    nextCursor: rows.length > f.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function tagView(db: Db, orgId: string, mode: Mode, id: string): Promise<Tag | null> {
  const row = await first<ViewRow>(db, `${VIEW} WHERE t.id = ? AND t.org_id = ? AND t.mode = ?`, [
    id,
    orgId,
    mode,
  ]);
  return row ? toTag(row) : null;
}

/** The tags that open this pass now: bound to it, and bound to its owner as a person. */
export async function passTagViews(
  db: Db,
  pass: { id: string; orgId: string; mode: Mode; ownerUserId: string | null },
): Promise<Tag[]> {
  // Found through the bindings' own indexes: an org's tag table can be large, a pass has few tags.
  const ids = await all<{ tag_id: string }>(
    db,
    `SELECT b.tag_id FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id AND t.org_id = ? AND t.mode = ?
     WHERE b.pass_id = ? AND b.scope = 'pass' AND b.ended_at IS NULL
     UNION
     SELECT b.tag_id FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id AND t.org_id = ? AND t.mode = ?
     WHERE b.user_id = ? AND b.scope = 'user' AND b.ended_at IS NULL`,
    [pass.orgId, pass.mode, pass.id, pass.orgId, pass.mode, pass.ownerUserId],
  );
  if (ids.length === 0) return [];
  const rows = await all<ViewRow>(
    db,
    `${VIEW} WHERE t.id IN (SELECT value FROM json_each(?)) AND t.org_id = ? AND t.mode = ? AND t.status = 'active'
     ORDER BY b.bound_at DESC, t.id DESC`,
    [JSON.stringify(ids.map((r) => r.tag_id)), pass.orgId, pass.mode],
  );
  return rows.map(toTag);
}

interface TagRaw {
  id: string;
  org_id: string;
  mode: Mode;
  hint: string;
  label: string | null;
  status: 'active' | 'retired';
}

const toRow = (r: TagRaw): TagRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  hint: r.hint,
  label: r.label,
  status: r.status,
});

export async function tagByRef(
  db: Db,
  orgId: string,
  mode: Mode,
  ref: string,
): Promise<TagRow | null> {
  const r = await first<TagRaw>(
    db,
    'SELECT id, org_id, mode, hint, label, status FROM nfc_tags WHERE org_id = ? AND mode = ? AND tag_ref = ?',
    [orgId, mode, ref],
  );
  return r ? toRow(r) : null;
}

/** A tag by id, before any tenant authority exists for it. */
export async function tagTarget(db: Db, id: string): Promise<TagRow | null> {
  const r = await first<TagRaw>(
    db,
    'SELECT id, org_id, mode, hint, label, status FROM nfc_tags WHERE id = ?',
    [id],
  );
  return r ? toRow(r) : null;
}

interface BindingRaw {
  id: string;
  tag_id: string;
  scope: 'pass' | 'user';
  pass_id: string;
  user_id: string | null;
  owner_user_id: string | null;
  end_cause: string | null;
}

const toBinding = (r: BindingRaw): BindingRow => ({
  id: r.id,
  tagId: r.tag_id,
  scope: r.scope,
  passId: r.pass_id,
  userId: r.user_id,
  passOwnerId: r.owner_user_id,
  endCause: r.end_cause,
});

const BINDING = `SELECT b.id, b.tag_id, b.scope, b.pass_id, b.user_id, p.owner_user_id, b.end_cause
  FROM tag_bindings b JOIN passes p ON p.id = b.pass_id`;

export async function activeBinding(db: Db, tagId: string): Promise<BindingRow | null> {
  const r = await first<BindingRaw>(db, `${BINDING} WHERE b.tag_id = ? AND b.ended_at IS NULL`, [
    tagId,
  ]);
  return r ? toBinding(r) : null;
}

/** The binding that ended last: its cause says whether the tag was reported lost. */
export async function lastEndedBinding(db: Db, tagId: string): Promise<BindingRow | null> {
  const r = await first<BindingRaw>(
    db,
    `${BINDING} WHERE b.tag_id = ? AND b.ended_at IS NOT NULL ORDER BY b.ended_at DESC, b.rowid DESC LIMIT 1`,
    [tagId],
  );
  return r ? toBinding(r) : null;
}

/** A binding by id, with its tag's tenant, before any authority exists for it. */
export async function bindingTarget(
  db: Db,
  id: string,
): Promise<(BindingRow & { orgId: string; mode: Mode; ended: boolean }) | null> {
  const r = await first<BindingRaw & { org_id: string; mode: Mode; ended_at: number | null }>(
    db,
    `SELECT b.id, b.tag_id, b.scope, b.pass_id, b.user_id, p.owner_user_id, b.end_cause, t.org_id, t.mode, b.ended_at
     FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id JOIN passes p ON p.id = b.pass_id WHERE b.id = ?`,
    [id],
  );
  return r ? { ...toBinding(r), orgId: r.org_id, mode: r.mode, ended: r.ended_at !== null } : null;
}

export async function passFacts(db: Db, passId: string): Promise<PassFacts | null> {
  const r = await first<{
    id: string;
    org_id: string;
    mode: Mode;
    owner_user_id: string | null;
    deleted_at: number | null;
  }>(db, 'SELECT id, org_id, mode, owner_user_id, deleted_at FROM passes WHERE id = ?', [passId]);
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        mode: r.mode,
        ownerUserId: r.owner_user_id,
        deletedAt: r.deleted_at,
      }
    : null;
}

export async function orgTagCount(db: Db, orgId: string, mode: Mode): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM nfc_tags WHERE org_id = ? AND mode = ?',
    [orgId, mode],
  );
  return row?.n ?? 0;
}
