import type { Personalization } from '../../../passkit/types.ts';
import { all, first, run } from '../../platform/db.ts';

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
  contentHash: string | null;
  deletedAt: number | null;
  createdAt: number;
  /** Registered devices; 0 when the query did not count them. */
  deviceCount: number;
  /** The org's slug, for download file names; null when the query did not join it. */
  orgSlug: string | null;
}

export interface PassDbRow {
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
  content_hash: string | null;
  deleted_at: number | null;
  created_at: number;
  device_count?: number;
  org_slug?: string | null;
}

/** Every pass column plus its registered-device count (registrations_pass index). */
export const PASS_SELECT = `SELECT *,
  (SELECT count(*) FROM registrations r WHERE r.pass_id = passes.id) AS device_count,
  (SELECT slug FROM orgs o WHERE o.id = passes.org_id) AS org_slug FROM passes`;

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
    contentHash: row.content_hash,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    deviceCount: row.device_count ?? 0,
    orgSlug: row.org_slug ?? null,
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
    `${PASS_SELECT} WHERE id = ? AND (? IS NULL OR org_id = ?) AND deleted_at IS NULL`,
    [id, orgScope, orgScope],
  );
  return row ? mapPass(row) : null;
}

export async function getPassByDownloadToken(db: D1Database, token: string): Promise<Pass | null> {
  const row = await first<PassDbRow>(
    db,
    `${PASS_SELECT} WHERE download_token = ? AND deleted_at IS NULL`,
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
  const row = await first<PassDbRow>(db, `${PASS_SELECT} WHERE identity_id = ? AND serial = ?`, [
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
  const row = await first<{
    id: string;
    slug: string;
    name: string;
    status: string;
    default_identity_id: string | null;
    branding: string | null;
  }>(db, 'SELECT id, slug, name, status, default_identity_id, branding FROM orgs WHERE id = ?', [
    orgId,
  ]);
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

export * from './repo-devices.ts';
export * from './repo-history.ts';
export * from './repo-list.ts';
export * from './repo-ops.ts';
export * from './repo-write.ts';
