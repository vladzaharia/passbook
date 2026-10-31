import type { Personalization } from '../../../passkit/types.ts';
import {
  all,
  batch,
  chunk,
  first,
  likeEscape,
  placeholders,
  run,
  stmt,
} from '../../platform/db.ts';

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

export interface NewPassRow {
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
  connectionId: string | null;
  externalRef: string | null;
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  now: number;
  createdBy: string | null;
  passJson: string;
  actorType: string | null;
  actorId: string | null;
}

/** The `pass_created` trigger records version 1 from the pending_* columns. */
export async function insertPass(db: D1Database, row: NewPassRow): Promise<void> {
  await run(
    db,
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
       web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email,
       connection_id, external_ref, object_key, object_sha256, object_size, modified_at, created_by, created_at,
       pending_cause, pending_actor_type, pending_actor_id, pending_pass_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?, ?, ?)`,
    [
      row.id,
      row.orgId,
      row.identityId,
      row.serial,
      row.templateId,
      row.templateVersion,
      row.authToken,
      row.downloadToken,
      row.webServiceUrl,
      JSON.stringify(row.personalization),
      JSON.stringify(row.fieldSources),
      row.displayTitle,
      row.displaySubtitle,
      row.externalId,
      row.holderEmail,
      row.connectionId,
      row.externalRef,
      row.objectKey,
      row.objectSha256,
      row.objectSize,
      row.now,
      row.createdBy,
      row.now,
      row.actorType,
      row.actorId,
      row.passJson,
    ],
  );
}

export interface PublishWrite {
  id: string;
  expectedVersion: number;
  previousModifiedAt: number;
  now: number;
  templateVersion: string;
  personalization: Personalization;
  fieldSources: FieldSources;
  displayTitle: string | null;
  displaySubtitle: string | null;
  externalId: string | null;
  status: PassStatus;
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  cause: PassCause;
  actorType: string | null;
  actorId: string | null;
  passJson: string;
}

/**
 * Compare-and-swap publish. RETURNING (not meta.changes) identifies the winner because D1 counts
 * trigger writes. Returns the new version, or null when another writer got there first.
 */
export async function casPublish(db: D1Database, w: PublishWrite): Promise<number | null> {
  const sameSecond = Math.floor(w.now / 1000) === Math.floor(w.previousModifiedAt / 1000);
  const row = await first<{ version: number }>(
    db,
    `UPDATE passes SET template_version = ?, personalization = ?, field_sources = ?, display_title = ?,
       display_subtitle = ?, external_id = ?, status = ?, object_key = ?, object_sha256 = ?, object_size = ?,
       modified_at = ?, modified_collision = ?, version = version + 1, sync_error_code = NULL,
       pending_cause = ?, pending_actor_type = ?, pending_actor_id = ?, pending_pass_json = ?
     WHERE id = ? AND version = ? RETURNING version`,
    [
      w.templateVersion,
      JSON.stringify(w.personalization),
      JSON.stringify(w.fieldSources),
      w.displayTitle,
      w.displaySubtitle,
      w.externalId,
      w.status,
      w.objectKey,
      w.objectSha256,
      w.objectSize,
      w.now,
      sameSecond ? 1 : 0,
      w.cause,
      w.actorType,
      w.actorId,
      w.passJson,
      w.id,
      w.expectedVersion,
    ],
  );
  return row?.version ?? null;
}

/** Metadata-only change (no new object, no push). Still bumps the version. */
export async function casMeta(
  db: D1Database,
  id: string,
  expectedVersion: number,
  set: { fieldSources: FieldSources; externalId: string | null },
): Promise<number | null> {
  const row = await first<{ version: number }>(
    db,
    `UPDATE passes SET field_sources = ?, external_id = ?, version = version + 1
     WHERE id = ? AND version = ? RETURNING version`,
    [JSON.stringify(set.fieldSources), set.externalId, id, expectedVersion],
  );
  return row?.version ?? null;
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

export interface VersionRow {
  version: number;
  templateVersion: string;
  cause: PassCause;
  actorType: string | null;
  actorId: string | null;
  createdAt: number;
  purged: boolean;
  personalization: Personalization;
  passJson: string | null;
}

interface VersionDbRow {
  version: number;
  template_version: string;
  cause: PassCause;
  actor_type: string | null;
  actor_id: string | null;
  created_at: number;
  purged_at: number | null;
  personalization: string;
  pass_json: string | null;
}

const mapVersion = (r: VersionDbRow): VersionRow => ({
  version: r.version,
  templateVersion: r.template_version,
  cause: r.cause,
  actorType: r.actor_type,
  actorId: r.actor_id,
  createdAt: r.created_at,
  purged: r.purged_at !== null,
  personalization: JSON.parse(r.personalization) as Personalization,
  passJson: r.pass_json,
});

export async function listVersions(
  db: D1Database,
  passId: string,
  limit = 50,
): Promise<VersionRow[]> {
  const rows = await all<VersionDbRow>(
    db,
    'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT ?',
    [passId, limit],
  );
  return rows.map(mapVersion);
}

export async function getVersion(
  db: D1Database,
  passId: string,
  version: number,
): Promise<VersionRow | null> {
  const row = await first<VersionDbRow>(
    db,
    'SELECT * FROM pass_versions WHERE pass_id = ? AND version = ?',
    [passId, version],
  );
  return row ? mapVersion(row) : null;
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

export async function markRefreshed(db: D1Database, id: string, now: number): Promise<void> {
  await run(db, 'UPDATE passes SET last_refreshed_at = ? WHERE id = ?', [now, id]);
}

export async function setSyncError(db: D1Database, id: string, code: string | null): Promise<void> {
  await run(db, 'UPDATE passes SET sync_error_code = ? WHERE id = ?', [code, id]);
}

export interface AssetRow {
  name: string;
  r2Key: string;
  sha1: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export async function listAssets(db: D1Database, passId: string): Promise<AssetRow[]> {
  const rows = await all<{
    name: string;
    r2_key: string;
    sha1: string;
    size: number;
    width: number | null;
    height: number | null;
    created_at: number;
  }>(db, 'SELECT * FROM pass_assets WHERE pass_id = ? ORDER BY name', [passId]);
  return rows.map((r) => ({
    name: r.name,
    r2Key: r.r2_key,
    sha1: r.sha1,
    size: r.size,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
  }));
}

export async function upsertAsset(
  db: D1Database,
  passId: string,
  asset: AssetRow,
): Promise<AssetRow | null> {
  const previous = (await listAssets(db, passId)).find((a) => a.name === asset.name) ?? null;
  await run(
    db,
    `INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (pass_id, name) DO UPDATE SET r2_key = excluded.r2_key, sha1 = excluded.sha1,
       size = excluded.size, width = excluded.width, height = excluded.height, created_at = excluded.created_at`,
    [
      passId,
      asset.name,
      asset.r2Key,
      asset.sha1,
      asset.size,
      asset.width,
      asset.height,
      asset.createdAt,
    ],
  );
  return previous;
}

export async function removeAsset(db: D1Database, passId: string, name: string): Promise<boolean> {
  return (
    (await run(db, 'DELETE FROM pass_assets WHERE pass_id = ? AND name = ?', [passId, name]))
      .changes > 0
  );
}

export interface DeletedPass {
  objectKeys: string[];
  deviceIds: { deviceId: string; identityId: string }[];
}

/** Collects what must be cleaned outside D1, then removes the rows (children cascade). */
export async function deletePassRows(db: D1Database, pass: Pass): Promise<DeletedPass> {
  const [versions, assets, devices] = await Promise.all([
    all<{ object_key: string | null }>(
      db,
      'SELECT object_key FROM pass_versions WHERE pass_id = ? AND object_key IS NOT NULL',
      [pass.id],
    ),
    listAssets(db, pass.id),
    all<{ device_id: string; identity_id: string }>(
      db,
      'SELECT device_id, identity_id FROM registrations WHERE pass_id = ?',
      [pass.id],
    ),
  ]);
  const keys = new Set<string>([pass.objectKey]);
  for (const v of versions) if (v.object_key) keys.add(v.object_key);
  for (const a of assets) keys.add(a.r2Key);
  await batch(db, [
    stmt(db, 'DELETE FROM passes WHERE id = ?', [pass.id]),
    ...devices.map((d) =>
      stmt(
        db,
        `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = devices.device_id AND r.identity_id = devices.identity_id)`,
        [d.device_id, d.identity_id],
      ),
    ),
  ]);
  return {
    objectKeys: [...keys],
    deviceIds: devices.map((d) => ({ deviceId: d.device_id, identityId: d.identity_id })),
  };
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (const part of chunk(keys, 500)) await bucket.delete(part);
}

export async function passesForTemplate(
  db: D1Database,
  templateId: string,
  orgId: string | null,
  afterId: string | null,
  limit: number,
): Promise<Pass[]> {
  const rows = await all<PassDbRow>(
    db,
    `SELECT * FROM passes WHERE template_id = ? AND (? IS NULL OR org_id = ?) AND id > ?
     ORDER BY id LIMIT ?`,
    [templateId, orgId, orgId, afterId ?? '', limit],
  );
  return rows.map(mapPass);
}

export async function passesByIds(db: D1Database, ids: string[]): Promise<Pass[]> {
  if (ids.length === 0) return [];
  const rows = await all<PassDbRow>(
    db,
    `SELECT * FROM passes WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return rows.map(mapPass);
}

export interface IdempotencyRow {
  requestHash: string;
  resourceId: string | null;
}

export async function claimIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  requestHash: string,
  now: number,
): Promise<boolean> {
  return (
    (
      await run(
        db,
        `INSERT OR IGNORE INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)`,
        [orgId, key, requestHash, now],
      )
    ).changes === 1
  );
}

export async function getIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const row = await first<{ request_hash: string; resource_id: string | null }>(
    db,
    'SELECT request_hash, resource_id FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [orgId, key],
  );
  return row ? { requestHash: row.request_hash, resourceId: row.resource_id } : null;
}

export async function finishIdempotencyKey(
  db: D1Database,
  orgId: string,
  key: string,
  resourceId: string | null,
): Promise<void> {
  if (resourceId === null)
    await run(db, 'DELETE FROM idempotency_keys WHERE org_id = ? AND key = ?', [orgId, key]);
  else
    await run(db, 'UPDATE idempotency_keys SET resource_id = ? WHERE org_id = ? AND key = ?', [
      resourceId,
      orgId,
      key,
    ]);
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

export async function passesForReissue(
  db: D1Database,
  q: {
    templateId: string;
    orgId: string | null;
    afterId: string | null;
    limit: number;
    skipVersion: string | null;
  },
): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE template_id = ? AND (? IS NULL OR org_id = ?) AND id > ?
       AND (? IS NULL OR template_version != ?) ORDER BY id LIMIT ?`,
    [q.templateId, q.orgId, q.orgId, q.afterId ?? '', q.skipVersion, q.skipVersion, q.limit],
  );
}

export async function insertWorkflowRun(
  db: D1Database,
  row: {
    instanceId: string;
    kind: 'bulk_reissue';
    orgId: string | null;
    targetId: string;
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
    [row.instanceId, row.kind, row.orgId, row.targetId, row.now],
  );
}

export async function setWorkflowStatus(
  db: D1Database,
  instanceId: string,
  status: 'running' | 'complete' | 'errored',
  now: number,
  errorCode: string | null = null,
): Promise<void> {
  await run(
    db,
    `UPDATE workflow_runs SET status = ?, finished_at = ?, error_code = ? WHERE instance_id = ?`,
    [status, status === 'running' ? null : now, errorCode, instanceId],
  );
}

export interface PurgeCandidate {
  passId: string;
  version: number;
  objectKey: string | null;
}

/** Versions with more than `keep` newer rows: everything except the current one and the last `keep`. */
export async function versionsToPurge(
  db: D1Database,
  keep: number,
  limit: number,
  passId?: string,
): Promise<PurgeCandidate[]> {
  const rows = await all<{ pass_id: string; version: number; object_key: string | null }>(
    db,
    `SELECT pv.pass_id, pv.version, pv.object_key FROM pass_versions pv
     WHERE pv.purged_at IS NULL AND (? IS NULL OR pv.pass_id = ?)
       AND (SELECT count(*) FROM pass_versions n WHERE n.pass_id = pv.pass_id AND n.version > pv.version) > ?
     LIMIT ?`,
    [passId ?? null, passId ?? null, keep, limit],
  );
  return rows.map((r) => ({ passId: r.pass_id, version: r.version, objectKey: r.object_key }));
}

export async function markPurged(
  db: D1Database,
  rows: PurgeCandidate[],
  now: number,
): Promise<void> {
  for (const part of chunk(rows, 50)) {
    await batch(
      db,
      part.map((r) =>
        stmt(
          db,
          `UPDATE pass_versions SET purged_at = ?, object_key = NULL, pass_json = NULL
           WHERE pass_id = ? AND version = ?`,
          [now, r.passId, r.version],
        ),
      ),
    );
  }
}

export async function deleteIdempotencyBefore(db: D1Database, before: number): Promise<number> {
  return (await run(db, 'DELETE FROM idempotency_keys WHERE created_at < ?', [before])).changes;
}
