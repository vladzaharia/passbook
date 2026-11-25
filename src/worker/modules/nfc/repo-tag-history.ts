import type { Mode } from '../../../shared/contracts/common.ts';
import type { TagBinding } from '../../../shared/contracts/nfc-tags.ts';
import { all, first } from '../../platform/db.ts';

type Db = D1Database;

interface Raw {
  id: string;
  tag_id: string;
  scope: 'pass' | 'user';
  pass_id: string;
  user_id: string | null;
  source: 'scanner' | 'remote' | 'admin';
  bound_at: number;
  ended_at: number | null;
  end_cause: TagBinding['endCause'];
  pass_title: string | null;
  holder_name: string | null;
  bound_by_name: string | null;
  scanner_name: string | null;
  type_use: string | null;
}

/** A binding with the names a person reads; ended ones too. The tag's org keeps every name in its tenant. */
const SELECT = `SELECT b.id, b.tag_id, b.scope, b.pass_id, b.user_id, b.source, b.bound_at, b.ended_at, b.end_cause,
    p.display_title AS pass_title, hu.name AS holder_name,
    CASE b.bound_by_type
      WHEN 'user' THEN (SELECT u.name FROM users u WHERE u.id = b.bound_by)
      WHEN 'staff' THEN (SELECT s.name FROM scan_staff s WHERE s.id = b.bound_by AND s.org_id = t.org_id)
      ELSE (SELECT s.name FROM scanners s WHERE s.id = b.bound_by AND s.org_id = t.org_id) END AS bound_by_name,
    (SELECT s.name FROM scanners s WHERE s.id = b.scanner_id AND s.org_id = t.org_id) AS scanner_name,
    y.use AS type_use
  FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
  LEFT JOIN nfc_tag_types y ON y.id = t.type_id AND y.org_id = t.org_id
  LEFT JOIN passes p ON p.id = b.pass_id AND p.org_id = t.org_id AND p.mode = t.mode
  LEFT JOIN users hu ON hu.id = b.user_id`;

const toBinding = (r: Raw): TagBinding => ({
  id: r.id,
  tagId: r.tag_id,
  scope: r.scope,
  passId: r.pass_id,
  passTitle: r.pass_title,
  userId: r.user_id,
  holderName: r.scope === 'user' ? r.holder_name : null,
  source: r.source,
  lent: r.type_use === 'visitor',
  boundAt: r.bound_at,
  boundByName: r.bound_by_name,
  scannerName: r.scanner_name,
  endedAt: r.ended_at,
  endCause: r.end_cause,
});

export async function bindingView(db: Db, id: string): Promise<TagBinding | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE b.id = ?`, [id]);
  return r ? toBinding(r) : null;
}

/** The tag's bindings, newest first. `cursor` is the oldest `rowid` of the previous page. */
export async function tagBindingHistory(
  db: Db,
  tagId: string,
  limit: number,
  cursor?: number,
): Promise<{ items: TagBinding[]; nextCursor: string | null }> {
  const rows = await all<Raw & { rid: number }>(
    db,
    `${SELECT.replace('SELECT b.id,', 'SELECT b.rowid AS rid, b.id,')} WHERE b.tag_id = ?${cursor === undefined ? '' : ' AND b.rowid < ?'} ORDER BY b.rowid DESC LIMIT ?`,
    cursor === undefined ? [tagId, limit + 1] : [tagId, cursor, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(toBinding),
    nextCursor: rows.length > limit ? String(page.at(-1)?.rid ?? '') : null,
  };
}

export interface TagEvent {
  at: number;
  action: 'lost' | 'retire' | 'restore' | 'update';
  actorName: string | null;
}

/** Changes to the tag itself, from the audit log. Binds and unbinds are the binding rows. */
export async function tagEvents(db: Db, orgId: string, tagId: string): Promise<TagEvent[]> {
  const rows = await all<{ at: number; action: string; actor: string | null }>(
    db,
    `SELECT a.at, a.action, (SELECT u.name FROM users u WHERE u.id = a.actor_id AND a.actor_type = 'user') AS actor
     FROM audit_log a WHERE a.target_type = 'tag' AND a.target_id = ? AND a.org_id = ?
       AND a.action IN ('tag.lost', 'tag.retire', 'tag.restore', 'tag.update')
     ORDER BY a.id DESC LIMIT 50`,
    [tagId, orgId],
  );
  return rows.map((r) => ({
    at: r.at,
    action: r.action.slice(4) as TagEvent['action'],
    actorName: r.actor,
  }));
}

/** The most recent binding a tag had that is over: what Undo on remove puts back. */
export async function lastEndedBinding(
  db: Db,
  tagId: string,
): Promise<{
  passId: string;
  scope: 'pass' | 'user';
  userId: string | null;
  holderGeneration: number;
  holderOwner: string | null;
  endCause: string;
  endedAt: number;
  endedBy: string | null;
  endedByType: string | null;
} | null> {
  const r = await first<{
    pass_id: string;
    scope: 'pass' | 'user';
    user_id: string | null;
    holder_generation: number;
    holder_owner: string | null;
    end_cause: string;
    ended_at: number;
    ended_by: string | null;
    ended_by_type: string | null;
  }>(
    db,
    `SELECT pass_id, scope, user_id, holder_generation, holder_owner, end_cause, ended_at, ended_by, ended_by_type FROM tag_bindings
     WHERE tag_id = ? AND ended_at IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
    [tagId],
  );
  return r
    ? {
        passId: r.pass_id,
        scope: r.scope,
        userId: r.user_id,
        holderGeneration: r.holder_generation,
        holderOwner: r.holder_owner,
        endCause: r.end_cause,
        endedAt: r.ended_at,
        endedBy: r.ended_by,
        endedByType: r.ended_by_type,
      }
    : null;
}

/** The orgs where this user owns a live pass in the mode, with their names. */
export async function userPassOrgs(
  db: Db,
  userId: string,
  mode: Mode,
): Promise<{ orgId: string; orgName: string }[]> {
  const rows = await all<{ id: string; name: string }>(
    db,
    `SELECT o.id, o.name FROM orgs o WHERE o.id IN (
       SELECT p.org_id FROM passes p WHERE p.owner_user_id = ? AND p.mode = ? AND p.deleted_at IS NULL)
     ORDER BY o.name, o.id`,
    [userId, mode],
  );
  return rows.map((r) => ({ orgId: r.id, orgName: r.name }));
}

/** Tags that open any of the user's passes in this org: bound to the person, or to one of those passes. */
export async function userTagIds(
  db: Db,
  orgId: string,
  mode: Mode,
  userId: string,
): Promise<string[]> {
  const rows = await all<{ tag_id: string }>(
    db,
    `SELECT b.tag_id FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id AND t.org_id = ? AND t.mode = ?
     WHERE b.user_id = ? AND b.scope = 'user' AND b.ended_at IS NULL
     UNION
     SELECT b.tag_id FROM tag_bindings b JOIN passes p ON p.id = b.pass_id AND p.owner_user_id = ? AND p.deleted_at IS NULL
     JOIN nfc_tags t ON t.id = b.tag_id AND t.org_id = ? AND t.mode = ?
     WHERE b.scope = 'pass' AND b.ended_at IS NULL`,
    [orgId, mode, userId, userId, orgId, mode],
  );
  return rows.map((r) => r.tag_id);
}

/** An org's name, for a list that names the org its rows belong to. */
export async function orgNameOf(db: Db, orgId: string): Promise<string> {
  const r = await first<{ name: string }>(db, 'SELECT name FROM orgs WHERE id = ?', [orgId]);
  return r?.name ?? '';
}
