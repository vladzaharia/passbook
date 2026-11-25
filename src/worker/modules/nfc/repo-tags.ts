import type { Mode } from '../../../shared/contracts/common.ts';
import type { Tag, TagBinding } from '../../../shared/contracts/nfc-tags.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { assuranceOfSystem } from './systems/registry.ts';

type Db = D1Database;

export interface TagRow {
  id: string;
  orgId: string;
  mode: Mode;
  system: 'uid' | 'sun';
  typeId: string | null;
  hint: string;
  label: string | null;
  status: 'active' | 'retired';
  lostAt: number | null;
  lostBy: string | null;
}

const VIEW = `SELECT t.id, t.mode, t.system, t.hint, t.label, t.status, t.created_at, t.last_seen_at,
    b.id AS b_id, b.scope AS b_scope, b.pass_id AS b_pass_id, b.user_id AS b_user_id, b.source AS b_source,
    b.bound_at AS b_bound_at, b.expires_at AS b_expires_at,
    y.id AS type_id, y.name AS type_name, y.use AS type_use, p.display_title AS pass_title, hu.name AS holder_name,
    CASE b.bound_by_type
      WHEN 'user' THEN (SELECT u.name FROM users u WHERE u.id = b.bound_by)
      WHEN 'staff' THEN (SELECT s.name FROM scan_staff s WHERE s.id = b.bound_by AND s.org_id = t.org_id)
      ELSE (SELECT s.name FROM scanners s WHERE s.id = b.bound_by AND s.org_id = t.org_id) END AS bound_by_name,
    (SELECT s.name FROM scanners s WHERE s.id = b.scanner_id AND s.org_id = t.org_id) AS scanner_name,
    t.lost_at
  FROM nfc_tags t INDEXED BY nfc_tags_list
  LEFT JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL
  LEFT JOIN passes p ON p.id = b.pass_id AND p.org_id = t.org_id AND p.mode = t.mode
  LEFT JOIN users hu ON hu.id = b.user_id
  LEFT JOIN nfc_tag_types y ON y.id = t.type_id AND y.org_id = t.org_id`;

interface ViewRow {
  id: string;
  mode: Mode;
  system: 'uid' | 'sun';
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
  b_expires_at: number | null;
  type_id: string | null;
  type_name: string | null;
  type_use: 'member' | 'staff' | 'visitor' | null;
  pass_title: string | null;
  holder_name: string | null;
  bound_by_name: string | null;
  scanner_name: string | null;
  lost_at: number | null;
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
          lent: r.type_use === 'visitor',
          boundAt: r.b_bound_at,
          boundByName: r.bound_by_name,
          scannerName: r.scanner_name,
          expiresAt: r.b_expires_at,
          endedAt: null,
          endCause: null,
        }
      : null;
  const state =
    r.status === 'retired'
      ? 'retired'
      : binding
        ? binding.lent
          ? 'lent'
          : 'assigned'
        : r.lost_at !== null
          ? 'lost'
          : 'spare';
  return {
    id: r.id,
    mode: r.mode,
    kind: r.system,
    system: r.system,
    type:
      r.type_id && r.type_name && r.type_use
        ? { id: r.type_id, name: r.type_name, use: r.type_use }
        : null,
    assurance: assuranceOfSystem(r.system),
    hint: r.hint,
    label: r.label,
    pool: r.type_use === 'visitor',
    status: r.status,
    state,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    keysetId: null,
    binding,
  };
}

const STATE_SQL = {
  assigned: "t.status = 'active' AND b.id IS NOT NULL AND y.use IS NOT 'visitor'",
  retired: "t.status = 'retired'",
  lost: "t.status = 'active' AND b.id IS NULL AND t.lost_at IS NOT NULL",
  spare: "t.status = 'active' AND b.id IS NULL AND t.lost_at IS NULL",
  lent: "t.status = 'active' AND b.id IS NOT NULL AND y.use = 'visitor'",
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
  return tagViewsByIds(
    db,
    pass.orgId,
    pass.mode,
    ids.map((r) => r.tag_id),
  );
}

/** Active tags by id, newest binding first. */
export async function tagViewsByIds(
  db: Db,
  orgId: string,
  mode: Mode,
  ids: string[],
): Promise<Tag[]> {
  if (ids.length === 0) return [];
  const rows = await all<ViewRow>(
    db,
    `${VIEW} WHERE t.id IN (SELECT value FROM json_each(?)) AND t.org_id = ? AND t.mode = ? AND t.status = 'active'
     ORDER BY b.bound_at DESC, t.id DESC`,
    [JSON.stringify(ids), orgId, mode],
  );
  return rows.map(toTag);
}

interface TagRaw {
  id: string;
  org_id: string;
  mode: Mode;
  system: 'uid' | 'sun';
  type_id: string | null;
  hint: string;
  label: string | null;
  status: 'active' | 'retired';
  lost_at: number | null;
  lost_by: string | null;
}

const toRow = (r: TagRaw): TagRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  system: r.system,
  typeId: r.type_id,
  hint: r.hint,
  label: r.label,
  status: r.status,
  lostAt: r.lost_at,
  lostBy: r.lost_by,
});

export async function tagByRef(
  db: Db,
  orgId: string,
  mode: Mode,
  ref: string,
): Promise<TagRow | null> {
  const r = await first<TagRaw>(
    db,
    'SELECT id, org_id, mode, system, type_id, hint, label, status, lost_at, lost_by FROM nfc_tags WHERE org_id = ? AND mode = ? AND tag_ref = ?',
    [orgId, mode, ref],
  );
  return r ? toRow(r) : null;
}

/** A tag by id, before any tenant authority exists for it. */
export async function tagTarget(db: Db, id: string): Promise<TagRow | null> {
  const r = await first<TagRaw>(
    db,
    'SELECT id, org_id, mode, system, type_id, hint, label, status, lost_at, lost_by FROM nfc_tags WHERE id = ?',
    [id],
  );
  return r ? toRow(r) : null;
}

export async function orgTagCount(db: Db, orgId: string, mode: Mode): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM nfc_tags WHERE org_id = ? AND mode = ?',
    [orgId, mode],
  );
  return row?.n ?? 0;
}
