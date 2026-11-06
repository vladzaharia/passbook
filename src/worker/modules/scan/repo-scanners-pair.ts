import type { Mode } from '../../../shared/contracts/common.ts';
import { first, stmt } from '../../platform/db.ts';
import { redactDetail } from '../audit/redact.ts';
import type { AuditEntry } from '../audit/types.ts';

type Db = D1Database;

export const setPairCodeStmt = (
  db: Db,
  id: string,
  hash: string,
  expiresAt: number,
  userId: string,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET pair_code_hash = ?, pair_expires_at = ?, pair_created_by = ?, updated_at = ?
     WHERE id = ?`,
    [hash, expiresAt, userId, now, id],
  );

export interface Credential {
  tokenPrefix: string;
  tokenHash: string;
  /** Null for a terminal. */
  csrfSecret: string | null;
  label: string | null;
  expiresAt: number;
  now: number;
}

/**
 * Installs a credential over the old one (the old token stops matching now), reactivates a revoked
 * scanner and ends any staff binding. Consumes a pairing code when `codeHash` is given, and then
 * only if it is unexpired. Returns a row only when it applied, so a concurrent loser gets none.
 */
export function installCredentialStmt(
  db: Db,
  id: string,
  c: Credential,
  codeHash: string | null,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scanners SET token_prefix = ?, token_hash = ?, csrf_secret = ?, paired_at = ?, paired_label = ?,
       expires_at = ?, last_seen_at = ?, revoked_at = NULL, updated_at = ?,
       staff_id = NULL, staff_since = NULL, staff_seen_at = NULL,
       pair_code_hash = NULL
     WHERE id = ? AND kind != 'display' ${codeHash ? 'AND pair_code_hash = ? AND pair_expires_at > ?' : ''}
     RETURNING id`,
    [
      c.tokenPrefix,
      c.tokenHash,
      c.csrfSecret,
      c.now,
      c.label,
      c.expiresAt,
      c.now,
      c.now,
      id,
      ...(codeHash ? [codeHash, c.now] : []),
    ],
  );
}

/** An audit row that lands only while the scanner holds this token hash: a pairing's winner, an unpair. */
export function heldAuditStmt(
  db: Db,
  ctx: { clock: { now(): number }; requestId: string | null },
  entry: AuditEntry,
  tokenHash: string,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM scanners WHERE id = ? AND token_hash = ?)`,
    [
      ctx.clock.now(),
      entry.orgId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      ctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
      entry.targetId ?? null,
      tokenHash,
    ],
  );
}

export interface PairTarget {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  orgName: string;
}

/** A live code of an active org. The same row answers preview and pair. */
export const findByPairCode = (db: Db, hash: string, now: number): Promise<PairTarget | null> =>
  first<{ id: string; org_id: string; mode: Mode; name: string; org_name: string }>(
    db,
    `SELECT s.id, s.org_id, s.mode, s.name, o.name AS org_name
     FROM scanners s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
     WHERE s.pair_code_hash = ? AND s.pair_expires_at > ? AND s.kind != 'display'`,
    [hash, now],
  ).then((r) =>
    r ? { id: r.id, orgId: r.org_id, mode: r.mode, name: r.name, orgName: r.org_name } : null,
  );

/** Clears the token of a device that unpaired itself. Matches only the token it presented. */
export const clearTokenStmt = (
  db: Db,
  id: string,
  tokenHash: string,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET token_prefix = NULL, token_hash = NULL, csrf_secret = NULL, paired_at = NULL,
       paired_label = NULL, expires_at = NULL, updated_at = ?,
       staff_id = NULL, staff_since = NULL, staff_seen_at = NULL
     WHERE id = ? AND token_hash = ? AND kind = 'device'
     RETURNING id, org_id`,
    [now, id, tokenHash],
  );
