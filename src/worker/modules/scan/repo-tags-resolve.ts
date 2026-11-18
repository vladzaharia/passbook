import type { Mode } from '../../../shared/contracts/common.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { tenantMatch } from '../../platform/authority-checks.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanTagAuthority } from './actor.ts';
import { byIdsInStmt } from './repo-lookup.ts';

/** At most this many of a user's passes are read for one tag (design §3.5). */
export const TAG_CANDIDATES_READ = 8;

/** The tag row and its active binding, in the actor's org and mode. */
export interface TagState {
  id: string;
  kind: string;
  status: string;
  hint: string;
  lostAt: number | null;
  binding: {
    id: string;
    scope: 'pass' | 'user';
    passId: string;
    userId: string | null;
    userActive: boolean;
  } | null;
}

const LIVE_TAG = `t.org_id = ? AND t.mode = ? AND t.tag_ref = ? AND t.status = 'active' AND t.lost_at IS NULL`;

/**
 * Ids of the passes an active binding of this tag reaches: the pass of a pass binding, or every
 * undeleted pass the bound user owns in the tag's org and mode while the account is active (D14).
 */
function tagPassIds(orgId: string, mode: Mode, ref: string): { sql: string; params: SqlValue[] } {
  return {
    sql: `SELECT b.pass_id FROM nfc_tags t
        JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL AND b.scope = 'pass'
        WHERE ${LIVE_TAG}
      UNION ALL
      SELECT o.id FROM nfc_tags t
        JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL AND b.scope = 'user'
        JOIN users u ON u.id = b.user_id AND u.status = 'active'
        JOIN passes o ON o.owner_user_id = b.user_id AND o.org_id = t.org_id AND o.mode = t.mode
          AND o.deleted_at IS NULL
        WHERE ${LIVE_TAG}`,
    params: [orgId, mode, ref, orgId, mode, ref],
  };
}

export const tagStateStmt = (db: D1Database, orgId: string, mode: Mode, ref: string) =>
  stmt(
    db,
    `SELECT t.id, t.kind, t.status, t.hint, t.lost_at, b.id AS binding_id, b.scope, b.pass_id, b.user_id,
      (SELECT u.status FROM users u WHERE u.id = b.user_id) AS user_status
    FROM nfc_tags t LEFT JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL
    WHERE t.org_id = ? AND t.mode = ? AND t.tag_ref = ?`,
    [orgId, mode, ref],
  );

/** The same UID is a live tag with a binding in the other mode: `test_pass` / `live_pass`. */
export const otherModeTagStmt = (db: D1Database, orgId: string, mode: Mode, ref: string) =>
  stmt(
    db,
    `SELECT 1 AS hit FROM nfc_tags t JOIN tag_bindings b ON b.tag_id = t.id AND b.ended_at IS NULL
    WHERE ${LIVE_TAG} LIMIT 1`,
    [orgId, mode, ref],
  );

/** The org switch `nfc.tags`; absent means off. */
export const tagsSwitchStmt = (db: D1Database, orgId: string) =>
  stmt(db, "SELECT value FROM settings WHERE scope = ? AND key = 'nfc.tags'", [`org:${orgId}`]);

/** Full candidate rows for the tag's passes: active before voided or removed, then oldest. */
export const tagCandidatesStmt = (db: D1Database, orgId: string, mode: Mode, ref: string) =>
  byIdsInStmt(
    db,
    orgId,
    mode,
    tagPassIds(orgId, mode, ref),
    "(p.status <> 'voided' AND p.removed_at IS NULL) DESC, p.created_at, p.id",
    TAG_CANDIDATES_READ,
  );

/** Which of the tag's passes are inside one of the session's zones now (an exit prefers them). */
export const tagInsideStmt = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  ref: string,
  sessionId: string,
) => {
  const ids = tagPassIds(orgId, mode, ref);
  return stmt(
    db,
    `SELECT DISTINCT sp.pass_id FROM scan_presence sp
    JOIN scanning_session_zones z ON z.session_id = ? AND sp.scope = 'zone:' || z.zone_id
    WHERE sp.org_id = ? AND sp.state = 'in' AND sp.pass_id IN (${ids.sql})`,
    [sessionId, orgId, ...ids.params],
  );
};

/** The pass of the heads-up scan an override names. */
export const overriddenPassStmt = (db: D1Database, orgId: string, mode: Mode, scanId: string) =>
  stmt(db, 'SELECT pass_id FROM scans WHERE id = ? AND org_id = ? AND mode = ?', [
    scanId,
    orgId,
    mode,
  ]);

interface RawTag {
  id: string;
  kind: string;
  status: string;
  hint: string;
  lost_at: number | null;
  binding_id: string | null;
  scope: 'pass' | 'user' | null;
  pass_id: string | null;
  user_id: string | null;
  user_status: string | null;
}

export function tagStateOf(result: D1Result | undefined): TagState | null {
  const row = result?.results?.[0] as RawTag | undefined;
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    hint: row.hint,
    lostAt: row.lost_at,
    binding:
      row.binding_id && row.scope && row.pass_id
        ? {
            id: row.binding_id,
            scope: row.scope,
            passId: row.pass_id,
            userId: row.user_id,
            userActive: row.user_status === 'active',
          }
        : null,
  };
}

export function tagsOn(result: D1Result | undefined): boolean {
  const value = (result?.results?.[0] as { value?: unknown } | undefined)?.value;
  if (typeof value !== 'string') return false;
  try {
    return (JSON.parse(value) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export const passIdsOf = (result: D1Result | undefined): Set<string> =>
  new Set(
    ((result?.results ?? []) as { pass_id: string | null }[]).flatMap((r) => r.pass_id ?? []),
  );

/**
 * The scan's tag, binding and pass are still what the read chose, in the grant's transaction: the tag is
 * active and not lost, the binding active, and the pass is the bound pass or one the bound user still owns
 * in the tag's org and mode with an active account. A transfer or a lost report racing the scan refuses it.
 */
export function tagBindingCheck(tag: ScanTagAuthority): Check {
  return {
    reason: 'lineage',
    ok: (b, scope) =>
      `EXISTS (SELECT 1 FROM tag_bindings tb JOIN nfc_tags t ON t.id = tb.tag_id
        JOIN passes tp ON tp.id = ${b.bind(tag.passId)}
        WHERE tb.id = ${b.bind(tag.bindingId)} AND tb.tag_id = ${b.bind(tag.tagId)}
          AND tb.ended_at IS NULL AND tb.scope = ${b.bind(tag.scope)}
          AND t.status = 'active' AND t.lost_at IS NULL AND ${tenantMatch('nfc_tags', 't', scope)}
          AND tp.org_id = t.org_id AND tp.mode = t.mode AND tp.deleted_at IS NULL
          AND (tb.scope = 'pass' AND tb.pass_id = tp.id
            OR tb.scope = 'user' AND tp.owner_user_id = tb.user_id
              AND EXISTS (SELECT 1 FROM users tu WHERE tu.id = tb.user_id AND tu.status = 'active')))`,
  };
}
