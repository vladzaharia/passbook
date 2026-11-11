import type { Mode } from '../../../shared/contracts/common.ts';
import type { SqlValue } from '../../platform/db.ts';
import { all, first, run } from '../../platform/db.ts';
import { orgForPass } from '../orgs/repo.ts';
import { mapPass, PASS_SELECT, type Pass, type PassDbRow } from './repo-map.ts';
import { readMode, type ScopeArg, scopeOrg } from './scope.ts';

export * from './repo-map.ts';

/** Null scope = platform-wide. A pass outside the scope (org, or an API key's mode) reads as missing. */
export async function getPass(
  db: D1Database,
  id: string,
  scope: ScopeArg = null,
): Promise<Pass | null> {
  const orgScope = scopeOrg(scope);
  const mode = readMode(scope);
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE id = ? AND (? IS NULL OR org_id = ?) AND (? IS NULL OR mode = ?) AND deleted_at IS NULL AND test_data_quarantined = 0`,
    [id, orgScope, orgScope, mode, mode],
  );
  return row ? mapPass(row) : null;
}

export async function getPassByDownloadToken(db: D1Database, token: string): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE download_token = ? AND deleted_at IS NULL AND test_data_quarantined = 0`,
    [token],
  );
  return row ? mapPass(row) : null;
}

/** Includes soft-deleted passes: devices still receive the voided pass until the retention purge. */
export async function getPassBySerial(
  db: D1Database,
  identityId: string,
  serial: string,
): Promise<Pass | null> {
  const row = await first<PassDbRow>(db, `${PASS_SELECT} WHERE identity_id = ? AND serial = ? AND test_data_quarantined = 0`, [
    identityId,
    serial,
  ]);
  return row ? mapPass(row) : null;
}

/** Latest recorded pass.json. Metadata-only edits bump `version` without a new row, so no exact match. */
export async function currentPassJson(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ pass_json: string | null }>(
    db,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return row?.pass_json ?? null;
}

export async function listBlockedUsers(
  db: D1Database,
  passId: string,
): Promise<{ id: string; name: string | null }[]> {
  return all<{ id: string; name: string | null }>(
    db,
    `SELECT u.id, COALESCE(u.name, u.primary_email) AS name FROM pass_attach_blocks b
     JOIN users u ON u.id = b.user_id WHERE b.pass_id = ? ORDER BY b.created_at`,
    [passId],
  );
}

export async function getOwnerLabel(
  db: D1Database,
  userId: string,
): Promise<{ name: string | null; email: string | null }> {
  const row = await first<{ name: string | null; email: string | null }>(
    db,
    'SELECT name, primary_email AS email FROM users WHERE id = ?',
    [userId],
  );
  return row ?? { name: null, email: null };
}

export async function countRegistrations(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
    [passId],
  );
  return row?.n ?? 0;
}

export interface PassOrg {
  id: string;
  slug: string;
  name: string;
  status: string;
  defaultIdentityId: string | null;
  /** Raw branding JSON; read it with readBranding. */
  branding: unknown;
}

export async function getOrg(db: D1Database, orgId: string): Promise<PassOrg | null> {
  const row = await orgForPass(db, orgId);
  if (!row) return null;
  let branding: unknown = {};
  try {
    branding = JSON.parse(row.branding ?? '{}');
  } catch {
    // The column has a json_valid CHECK; a bad value means no branding, never a failed build.
    branding = {};
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    defaultIdentityId: row.default_identity_id,
    branding,
  };
}

export async function connectionInOrg(
  db: D1Database,
  connectionId: string,
  orgId: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM connections WHERE id = ? AND org_id = ?',
    [connectionId, orgId],
  );
  return row !== null;
}

/** The immutable context of one upstream result. Never fill missing fields from a later read. */
export interface ConnectionPassContext {
  passId: string;
  orgId: string;
  mode: 'live';
  status: 'active' | 'voided';
  expectedVersion: number;
  ownerUserId: string | null;
  linkGeneration: number;
  connectionId: string;
  externalRef: string;
  generation: number;
}

/** SQL and parameters shared by every final connector-owned write. */
export const connectionPassPredicate = `org_id = ? AND mode = ? AND mode = 'live'
  AND status = ? AND version = ? AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0
  AND connection_id = ? AND external_ref = ? AND owner_user_id IS ? AND link_generation = ?
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
  AND EXISTS (SELECT 1 FROM connections c WHERE c.id = passes.connection_id
    AND c.org_id = passes.org_id AND c.enabled = 1 AND c.generation = ?)`;

export function connectionPassParams(context: ConnectionPassContext): SqlValue[] {
  return [
    context.orgId,
    context.mode,
    context.status,
    context.expectedVersion,
    context.connectionId,
    context.externalRef,
    context.ownerUserId,
    context.linkGeneration,
    context.generation,
  ];
}

export function validConnectionPassContext(context: ConnectionPassContext): boolean {
  return Boolean(
    context &&
      typeof context.passId === 'string' && context.passId &&
      typeof context.orgId === 'string' && context.orgId &&
      context.mode === 'live' &&
      (context.status === 'active' || context.status === 'voided') &&
      Number.isSafeInteger(context.expectedVersion) && context.expectedVersion > 0 &&
      (context.ownerUserId === null || typeof context.ownerUserId === 'string') &&
      Number.isSafeInteger(context.linkGeneration) && context.linkGeneration > 0 &&
      typeof context.connectionId === 'string' && context.connectionId &&
      typeof context.externalRef === 'string' && context.externalRef &&
      Number.isSafeInteger(context.generation) && context.generation > 0,
  );
}

export async function matchesConnectionPass(
  db: D1Database,
  context: ConnectionPassContext,
): Promise<boolean> {
  if (!validConnectionPassContext(context)) return false;
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND ${connectionPassPredicate}`,
    [context.passId, ...connectionPassParams(context)],
  );
  return row !== null;
}

/** Connections have no Test environment; their `mode` is only the scheduling strategy. */
export async function connectionForPass(
  db: D1Database,
  connectionId: string,
  orgId: string,
  mode: Mode,
): Promise<{ generation: number } | null> {
  if (mode !== 'live') return null;
  return first<{ generation: number }>(
    db,
    'SELECT generation FROM connections WHERE id = ? AND org_id = ? AND enabled = 1',
    [connectionId, orgId],
  );
}

export async function getCreateTemplate(
  db: D1Database,
  id: string,
): Promise<{ orgId: string | null; status: string; activeVersion: string | null } | null> {
  const row = await first<{ org_id: string | null; status: string; active_version: string | null }>(
    db,
    'SELECT org_id, status, active_version FROM templates WHERE id = ?',
    [id],
  );
  return row ? { orgId: row.org_id, status: row.status, activeVersion: row.active_version } : null;
}

export async function setDownloadToken(
  db: D1Database,
  id: string,
  token: string,
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET download_token = ?, download_token_rotated_at = ?, link_generation = link_generation + 1
     WHERE id = ?`,
    [token, now, id],
  );
}

export interface RefreshSnapshot {
  passId: string;
  orgId: string;
  mode: Mode;
  status: 'active' | 'voided';
  passVersion: number;
  connectionId: string | null;
  externalRef: string | null;
  generation: number | null;
  ownerUserId: string | null;
  linkGeneration: number;
}

const refreshPredicate = `org_id = ? AND mode = ? AND status = ? AND version = ?
  AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0 AND connection_id IS ? AND external_ref IS ?
  AND owner_user_id IS ? AND link_generation = ?
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
  AND ((connection_id IS NULL AND external_ref IS NULL AND ? IS NULL)
    OR (mode = 'live' AND status = 'active' AND connection_id IS NOT NULL AND external_ref IS NOT NULL
      AND EXISTS (SELECT 1 FROM connections c WHERE c.id = passes.connection_id
        AND c.org_id = passes.org_id AND c.enabled = 1 AND c.generation = ?)))`;

function refreshParams(snapshot: RefreshSnapshot): SqlValue[] {
  return [
    snapshot.orgId, snapshot.mode, snapshot.status, snapshot.passVersion,
    snapshot.connectionId, snapshot.externalRef,
    snapshot.ownerUserId, snapshot.linkGeneration,
    snapshot.generation, snapshot.generation,
  ];
}

/** Claims the refresh slot only while the entire selected context still matches. */
export async function claimRefresh(
  db: D1Database,
  snapshot: RefreshSnapshot,
  now: number,
  windowMs: number,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET refresh_requested_at = ?
     WHERE id = ? AND ${refreshPredicate}
       AND (refresh_requested_at IS NULL OR refresh_requested_at <= ?) RETURNING id`,
    [now, snapshot.passId, ...refreshParams(snapshot), now - windowMs],
  );
  return row !== null;
}

export async function matchesRefreshSnapshot(
  db: D1Database,
  snapshot: RefreshSnapshot,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND ${refreshPredicate}`,
    [snapshot.passId, ...refreshParams(snapshot)],
  );
  return row !== null;
}

/** Changes sync state only while the complete connector and holder snapshot still matches. */
export async function applyConnectionState(
  db: D1Database,
  context: ConnectionPassContext,
  expectedHolder: { holderEmail: string | null; ownerUserId: string | null },
  code: string | null,
): Promise<{ holderEmail: string | null; ownerUserId: string | null; linkGeneration: number; version: number } | null> {
  if (!validConnectionPassContext(context)) return null;
  const row = await first<{ holder_email: string | null; owner_user_id: string | null; link_generation: number; version: number }>(
    db,
    `UPDATE passes SET sync_error_code = ?
     WHERE id = ? AND holder_email IS ? AND owner_user_id IS ? AND ${connectionPassPredicate}
     RETURNING holder_email, owner_user_id, link_generation, version`,
    [code, context.passId, expectedHolder.holderEmail, expectedHolder.ownerUserId, ...connectionPassParams(context)],
  );
  return row ? {
    holderEmail: row.holder_email,
    ownerUserId: row.owner_user_id,
    linkGeneration: row.link_generation,
    version: row.version,
  } : null;
}

export async function findByConnectionRef(
  db: D1Database,
  orgId: string,
  connectionId: string,
  externalRef: string,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM passes WHERE connection_id = ? AND external_ref = ? AND org_id = ?',
    [connectionId, externalRef, orgId],
  );
  return row?.id ?? null;
}

/** Newest push row that has not started, for flushing before a delete. */
export async function pendingPushId(db: D1Database, passId: string): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' AND state IN ('pending', 'enqueued')
     ORDER BY created_at DESC LIMIT 1`,
    [passId],
  );
  return row?.id ?? null;
}

export * from './repo-devices.ts';
export * from './repo-history.ts';
export * from './repo-list.ts';
export * from './repo-ops.ts';
export * from './repo-write.ts';
