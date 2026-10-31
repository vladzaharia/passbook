import type { Personalization } from '../../../passkit/types.ts';
import { all, first, likeEscape, run } from '../../platform/db.ts';

export type PassStatus = 'active' | 'voided';
export type FieldSources = Record<string, 'manual' | 'connection'>;
export type PassCause =
  | 'create'
  | 'admin'
  | 'api'
  | 'connection'
  | 'user_refresh'
  | 'template_upgrade'
  | 'resign';

export interface Pass {
  id: string;
  orgId: string;
  identityId: string;
  serial: string;
  templateId: string;
  templateVersion: string;
  authToken: string;
  downloadToken: string;
  webServiceUrl: string;
  personalization: Personalization;
  fieldSources: FieldSources;
  displayTitle: string | null;
  displaySubtitle: string | null;
  externalId: string | null;
  holderEmail: string | null;
  ownerUserId: string | null;
  status: PassStatus;
  version: number;
  revision: number;
  objectKey: string;
  objectSha256: string | null;
  objectSize: number | null;
  modifiedAt: number;
  modifiedCollision: boolean;
  connectionId: string | null;
  externalRef: string | null;
  syncErrorCode: string | null;
  refreshRequestedAt: number | null;
  lastRefreshedAt: number | null;
  createdAt: number;
}

interface PassDbRow {
  id: string;
  org_id: string;
  identity_id: string;
  serial: string;
  template_id: string;
  template_version: string;
  auth_token: string;
  download_token: string;
  web_service_url: string;
  personalization: string;
  field_sources: string;
  display_title: string | null;
  display_subtitle: string | null;
  external_id: string | null;
  holder_email: string | null;
  owner_user_id: string | null;
  status: PassStatus;
  version: number;
  revision: number;
  object_key: string;
  object_sha256: string | null;
  object_size: number | null;
  modified_at: number;
  modified_collision: number;
  connection_id: string | null;
  external_ref: string | null;
  sync_error_code: string | null;
  refresh_requested_at: number | null;
  last_refreshed_at: number | null;
  created_at: number;
}

export function mapPass(row: PassDbRow): Pass {
  return {
    id: row.id,
    orgId: row.org_id,
    identityId: row.identity_id,
    serial: row.serial,
    templateId: row.template_id,
    templateVersion: row.template_version,
    authToken: row.auth_token,
    downloadToken: row.download_token,
    webServiceUrl: row.web_service_url,
    personalization: JSON.parse(row.personalization) as Personalization,
    fieldSources: JSON.parse(row.field_sources) as FieldSources,
    displayTitle: row.display_title,
    displaySubtitle: row.display_subtitle,
    externalId: row.external_id,
    holderEmail: row.holder_email,
    ownerUserId: row.owner_user_id,
    status: row.status,
    version: row.version,
    revision: row.revision,
    objectKey: row.object_key,
    objectSha256: row.object_sha256,
    objectSize: row.object_size,
    modifiedAt: row.modified_at,
    modifiedCollision: row.modified_collision === 1,
    connectionId: row.connection_id,
    externalRef: row.external_ref,
    syncErrorCode: row.sync_error_code,
    refreshRequestedAt: row.refresh_requested_at,
    lastRefreshedAt: row.last_refreshed_at,
    createdAt: row.created_at,
  };
}

/** `orgScope` null = platform-wide. A pass outside the scope reads as missing. */
export async function getPass(
  db: D1Database,
  id: string,
  orgScope: string | null = null,
): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    'SELECT * FROM passes WHERE id = ? AND (? IS NULL OR org_id = ?)',
    [id, orgScope, orgScope],
  );
  return row ? mapPass(row) : null;
}

export async function getPassByDownloadToken(db: D1Database, token: string): Promise<Pass | null> {
  const row = await first<PassDbRow>(db, 'SELECT * FROM passes WHERE download_token = ?', [token]);
  return row ? mapPass(row) : null;
}

export async function getPassBySerial(
  db: D1Database,
  identityId: string,
  serial: string,
): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    'SELECT * FROM passes WHERE identity_id = ? AND serial = ?',
    [identityId, serial],
  );
  return row ? mapPass(row) : null;
}

export interface PassListFilter {
  orgId?: string | null;
  templateId?: string;
  connectionId?: string;
  status?: PassStatus;
  holderEmail?: string;
  holderState?: 'unassigned' | 'waiting' | 'owned';
  q?: string;
  cursor?: string;
  limit: number;
}

const HOLDER_STATE_SQL = {
  unassigned: 'holder_email IS NULL AND owner_user_id IS NULL',
  waiting: 'holder_email IS NOT NULL AND owner_user_id IS NULL',
  owned: 'owner_user_id IS NOT NULL',
} as const;

/** Newest first by id (UUIDv7). Search is prefix-only on display fields, exact on serial. */
export async function listPasses(
  db: D1Database,
  filter: PassListFilter,
): Promise<{ items: Pass[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (filter.orgId) add('org_id = ?', filter.orgId);
  if (filter.templateId) add('template_id = ?', filter.templateId);
  if (filter.connectionId) add('connection_id = ?', filter.connectionId);
  if (filter.status) add('status = ?', filter.status);
  if (filter.holderEmail) add('holder_email = ?', filter.holderEmail);
  if (filter.holderState) where.push(HOLDER_STATE_SQL[filter.holderState]);
  if (filter.cursor) add('id < ?', filter.cursor);
  const q = filter.q?.trim();
  if (q) {
    const prefix = `${likeEscape(q)}%`;
    add(
      "(display_title LIKE ? ESCAPE '\\' OR display_subtitle LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\' OR holder_email LIKE ? ESCAPE '\\' OR serial = ?)",
      prefix,
      prefix,
      prefix,
      prefix,
      q,
    );
  }
  const rows = await all<PassDbRow>(
    db,
    `SELECT * FROM passes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    [...params, filter.limit + 1],
  );
  const page = rows.slice(0, filter.limit).map(mapPass);
  const last = page.at(-1);
  return { items: page, nextCursor: rows.length > filter.limit && last ? last.id : null };
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

export async function countRegistrations(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
    [passId],
  );
  return row?.n ?? 0;
}

export async function getOrg(
  db: D1Database,
  orgId: string,
): Promise<{ id: string; name: string; status: string; defaultIdentityId: string | null } | null> {
  const row = await first<{
    id: string;
    name: string;
    status: string;
    default_identity_id: string | null;
  }>(db, 'SELECT id, name, status, default_identity_id FROM orgs WHERE id = ?', [orgId]);
  return row
    ? { id: row.id, name: row.name, status: row.status, defaultIdentityId: row.default_identity_id }
    : null;
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

/** Claims the refresh slot unless one was claimed within the window. */
export async function claimRefresh(
  db: D1Database,
  id: string,
  now: number,
  windowMs: number,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET refresh_requested_at = ?
     WHERE id = ? AND (refresh_requested_at IS NULL OR refresh_requested_at <= ?) RETURNING id`,
    [now, id, now - windowMs],
  );
  return row !== null;
}

export async function setSyncError(db: D1Database, id: string, code: string | null): Promise<void> {
  await run(db, 'UPDATE passes SET sync_error_code = ? WHERE id = ?', [code, id]);
}

export async function connectionGeneration(db: D1Database, id: string): Promise<number | null> {
  const row = await first<{ generation: number }>(
    db,
    'SELECT generation FROM connections WHERE id = ?',
    [id],
  );
  return row?.generation ?? null;
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

export * from './repo-history.ts';
export * from './repo-ops.ts';
export * from './repo-write.ts';
