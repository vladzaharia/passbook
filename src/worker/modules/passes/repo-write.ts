import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { connectionPassParams, connectionPassPredicate, type ConnectionPassContext } from './repo.ts';
import type { FieldSources, Pass, PassCause, PassStatus } from './repo-map.ts';
import { barcodeHashOf, lookupHashOf, lookupValueOf } from './scan-code.ts';

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
  connectionGeneration: number | null;
  externalRef: string | null;
  objectKey: string;
  objectSha256: string;
  objectSize: number;
  contentHash: string;
  now: number;
  createdBy: string | null;
  passJson: string;
  actorType: string | null;
  actorId: string | null;
  mode: Mode;
  scanCode: string;
  barcodeHash: string | null;
  lookupHash: string | null;
}

/** The `pass_created` trigger records version 1 from the pending_* columns. */
export async function insertPass(db: D1Database, row: NewPassRow): Promise<boolean> {
  const inserted = await first<{ id: string }>(
    db,
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
       web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email,
       connection_id, external_ref, object_key, object_sha256, object_size, content_hash, modified_at, created_by, created_at,
       pending_cause, pending_actor_type, pending_actor_id, pending_pass_json, mode, test_data_quarantined, scan_code, barcode_hash, lookup_hash)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, 0, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ? AND status = 'active')
       AND EXISTS (SELECT 1 FROM templates t JOIN template_versions v
         ON v.template_id = t.id AND v.version = t.active_version
         WHERE t.id = ? AND (t.org_id IS NULL OR t.org_id = ?) AND t.status = 'active'
           AND t.active_version = ?)
       AND ((? IS NULL AND ? IS NULL AND ? IS NULL)
         OR (? IS NOT NULL AND ? IS NOT NULL AND ? = 'live' AND ? IS NOT NULL
           AND EXISTS (SELECT 1 FROM connections c WHERE c.id = ? AND c.org_id = ?
             AND c.enabled = 1 AND c.generation = ?)))
     RETURNING id`,
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
      row.contentHash,
      row.now,
      row.createdBy,
      row.now,
      row.actorType,
      row.actorId,
      row.passJson,
      row.mode,
      row.scanCode,
      row.barcodeHash,
      row.lookupHash,
      row.orgId,
      row.templateId,
      row.orgId,
      row.templateVersion,
      row.connectionId,
      row.externalRef,
      row.connectionGeneration,
      row.connectionId,
      row.externalRef,
      row.mode,
      row.connectionGeneration,
      row.connectionId,
      row.orgId,
      row.connectionGeneration,
    ],
  );
  return inserted !== null;
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
  contentHash: string;
  cause: PassCause;
  /** Why beside the cause (scan, broadcast, ...); copied to pass_versions.source by the trigger. */
  source: PassSource | null;
  actorType: string | null;
  actorId: string | null;
  passJson: string;
  barcodeHash: string | null;
  lookupHash: string | null;
  /** Written only while the pass has none (lazy backfill). */
  scanCode: string;
  commit?: CommitHook | undefined;
  /** Owner/credentials and lifecycle observed when this publish began. */
  expectedPass: PublishPassSnapshot;
  connectionContext?: ConnectionPassContext | undefined;
  connectionState?: ConnectionStateWrite | undefined;
}

export type PublishPassSnapshot = Pick<
  Pass,
  | 'orgId' | 'mode' | 'templateId' | 'templateVersion'
  | 'serial' | 'authToken' | 'holderEmail' | 'ownerUserId' | 'linkGeneration' | 'status' | 'removedAt'
>;

const publishSnapshotPredicate = `org_id = ? AND mode = ? AND template_id = ? AND template_version = ?
  AND serial = ? AND auth_token = ? AND holder_email IS ? AND owner_user_id IS ?
  AND link_generation = ? AND status = ? AND removed_at IS ? AND deleted_at IS NULL AND test_data_quarantined = 0`;

function publishSnapshotParams(pass: PublishPassSnapshot) {
  return [
    pass.orgId, pass.mode, pass.templateId, pass.templateVersion,
    pass.serial, pass.authToken, pass.holderEmail, pass.ownerUserId, pass.linkGeneration, pass.status, pass.removedAt,
  ];
}

/** Revalidates the exact build input before writing its artifact to R2. */
export async function matchesPublishSnapshot(
  db: D1Database,
  pass: Pass,
  connectionContext?: ConnectionPassContext,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM passes WHERE id = ? AND version = ? AND ${publishSnapshotPredicate}
      ${connectionContext ? `AND ${connectionPassPredicate}` : ''}`,
    [
      pass.id, pass.version, ...publishSnapshotParams(pass),
      ...(connectionContext ? connectionPassParams(connectionContext) : []),
    ],
  );
  return row !== null;
}

export interface ConnectionStateWrite {
  syncErrorCode: string | null;
  holderChange: { email: string; token: string; now: number } | null;
}

const holderChangeSql = `, holder_email = ?,
  owner_user_id = (SELECT CASE WHEN count(*) = 1 THEN min(u.id) END FROM users u
    WHERE u.status = 'active'
      AND EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?)
      AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = passes.id AND b.user_id = u.id)),
  download_token = ?, download_token_rotated_at = ?, link_generation = link_generation + 1`;

function holderChangeParams(change: NonNullable<ConnectionStateWrite['holderChange']>) {
  return [change.email, change.email, change.token, change.now];
}

function revokeOldBundles(
  db: D1Database,
  id: string,
  version: number,
  linkGeneration: number,
  change: ConnectionStateWrite['holderChange'] | undefined,
): D1PreparedStatement[] {
  if (!change) return [];
  return [stmt(
    db,
    `DELETE FROM bundle_passes WHERE pass_id = ?
      AND EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.download_token = ?
        AND p.version = ? AND p.link_generation = ?)`,
    [id, id, change.token, version, linkGeneration],
  )];
}

/** Statements that commit with a version write: each guards itself on the pass's `object_key`. */
export type CommitHook = (w: { objectKey: string; version: number }) => D1PreparedStatement[];

/** The UPDATE ... RETURNING and the hook's statements in one batch; null when the CAS lost. */
async function casBatch(
  db: D1Database,
  update: D1PreparedStatement,
  hooked: D1PreparedStatement[],
): Promise<number | null> {
  const results = await batch(db, [update, ...hooked]);
  const row = (results[0]?.results as { version: number }[] | undefined)?.[0];
  return row?.version ?? null;
}

/**
 * Compare-and-swap publish. RETURNING (not meta.changes) identifies the winner because D1 counts
 * trigger writes. Returns the new version, or null when another writer got there first.
 */
export async function casPublish(db: D1Database, w: PublishWrite): Promise<number | null> {
  const sameSecond = Math.floor(w.now / 1000) === Math.floor(w.previousModifiedAt / 1000);
  const update = stmt(
    db,
    `UPDATE passes SET template_version = ?, personalization = ?, field_sources = ?, display_title = ?,
       display_subtitle = ?, external_id = ?, status = ?, object_key = ?, object_sha256 = ?, object_size = ?,
       content_hash = ?, modified_at = ?, modified_collision = ?, version = version + 1, sync_error_code = ?,
       pending_cause = ?, pending_actor_type = ?, pending_actor_id = ?, pending_pass_json = ?,
       pending_source = ?, barcode_hash = ?, lookup_hash = ?, scan_code = COALESCE(scan_code, ?)
       ${w.connectionState?.holderChange ? holderChangeSql : ''}
     WHERE id = ? AND version = ? AND ${publishSnapshotPredicate}
       ${w.connectionContext ? `AND ${connectionPassPredicate}` : ''} RETURNING version`,
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
      w.contentHash,
      w.now,
      sameSecond ? 1 : 0,
      w.connectionState?.syncErrorCode ?? null,
      w.cause,
      w.actorType,
      w.actorId,
      w.passJson,
      w.source,
      w.barcodeHash,
      w.lookupHash,
      w.scanCode,
      ...(w.connectionState?.holderChange ? holderChangeParams(w.connectionState.holderChange) : []),
      w.id,
      w.expectedVersion,
      ...publishSnapshotParams(w.expectedPass),
      ...(w.connectionContext ? connectionPassParams(w.connectionContext) : []),
    ],
  );
  return casBatch(
    db,
    update,
    [
      ...revokeOldBundles(db, w.id, w.expectedVersion + 1, w.expectedPass.linkGeneration + 1, w.connectionState?.holderChange),
      ...(w.commit?.({ objectKey: w.objectKey, version: w.expectedVersion + 1 }) ?? []),
    ],
  );
}

/** Metadata-only change (no new object, no push). Still bumps the version. */
export async function casMeta(
  db: D1Database,
  id: string,
  expectedVersion: number,
  set: {
    personalization: Personalization;
    fieldSources: FieldSources;
    externalId: string | null;
    templateVersion: string;
    contentHash: string;
    barcodeHash: string | null;
    lookupHash: string | null;
    scanCode: string;
    /** The object key the pass keeps (a metadata write adds no object). */
    objectKey: string;
    expectedPass: PublishPassSnapshot;
    connectionContext?: ConnectionPassContext | undefined;
    connectionState?: ConnectionStateWrite | undefined;
    commit?: CommitHook | undefined;
  },
): Promise<number | null> {
  const update = stmt(
    db,
    `UPDATE passes SET personalization = ?, field_sources = ?, external_id = ?, template_version = ?, content_hash = ?,
       barcode_hash = ?, lookup_hash = ?, scan_code = COALESCE(scan_code, ?), version = version + 1
       ${set.connectionState ? ', sync_error_code = ?' : ''}
       ${set.connectionState?.holderChange ? holderChangeSql : ''}
     WHERE id = ? AND version = ? AND ${publishSnapshotPredicate}
       ${set.connectionContext ? `AND ${connectionPassPredicate}` : ''} RETURNING version`,
    [
      JSON.stringify(set.personalization),
      JSON.stringify(set.fieldSources),
      set.externalId,
      set.templateVersion,
      set.contentHash,
      set.barcodeHash,
      set.lookupHash,
      set.scanCode,
      ...(set.connectionState ? [set.connectionState.syncErrorCode] : []),
      ...(set.connectionState?.holderChange ? holderChangeParams(set.connectionState.holderChange) : []),
      id,
      expectedVersion,
      ...publishSnapshotParams(set.expectedPass),
      ...(set.connectionContext ? connectionPassParams(set.connectionContext) : []),
    ],
  );
  return casBatch(
    db,
    update,
    [
      ...revokeOldBundles(db, id, expectedVersion + 1, set.expectedPass.linkGeneration + 1, set.connectionState?.holderChange),
      ...(set.commit?.({ objectKey: set.objectKey, version: expectedVersion + 1 }) ?? []),
    ],
  );
}

/** Binds or unbinds only the exact pass and target connection that were reviewed. */
export async function setBinding(
  db: D1Database,
  pass: Pass,
  binding: {
    connectionId: string | null;
    externalRef: string | null;
    fieldSources: FieldSources;
    generation: number | null;
  },
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `UPDATE passes SET connection_id = ?, external_ref = ?, field_sources = ?, sync_error_code = NULL,
       version = version + 1, refresh_requested_at = NULL
     WHERE id = ? AND org_id = ? AND mode = ? AND status = ? AND version = ?
       AND deleted_at IS NULL AND removed_at IS NULL AND test_data_quarantined = 0 AND connection_id IS ? AND external_ref IS ?
       AND serial = ? AND auth_token = ? AND holder_email IS ? AND owner_user_id IS ? AND link_generation = ?
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = passes.org_id AND o.status = 'active')
       AND ((? IS NULL AND ? IS NULL AND ? IS NULL)
         OR (mode = 'live' AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL
           AND EXISTS (SELECT 1 FROM connections c WHERE c.id = ? AND c.org_id = passes.org_id
             AND c.enabled = 1 AND c.generation = ?)))
     RETURNING id`,
    [
      binding.connectionId, binding.externalRef, JSON.stringify(binding.fieldSources),
      pass.id, pass.orgId, pass.mode, pass.status, pass.version, pass.connectionId, pass.externalRef,
      pass.serial, pass.authToken, pass.holderEmail, pass.ownerUserId, pass.linkGeneration,
      binding.connectionId, binding.externalRef, binding.generation,
      binding.connectionId, binding.externalRef, binding.generation,
      binding.connectionId, binding.generation,
    ],
  );
  return row !== null;
}

interface BackfillRow {
  id: string;
  scan_code: string | null;
  barcode_hash: string | null;
  lookup_hash: string | null;
  removed_at: number | null;
  personalization: string;
  lookup_input: string | null;
  pass_json: string | null;
}

/**
 * Fills `scan_code`, `barcode_hash` and `lookup_hash` on passes that predate them. A key is only
 * a candidate when it can be computed (the barcode exists, the lookup input has a value), so
 * a finished backlog selects nothing. Removed passes keep a NULL `barcode_hash`.
 */
export async function backfillScanKeys(
  db: D1Database,
  limit: number,
  mintScanCode: () => string,
): Promise<number> {
  const rows = await all<BackfillRow>(
    db,
    `SELECT p.id, p.scan_code, p.barcode_hash, p.lookup_hash, p.removed_at, p.personalization,
       json_extract(tv.manifest, '$.scan.lookup.input') AS lookup_input, pv.pass_json
     FROM passes p
     LEFT JOIN template_versions tv ON tv.template_id = p.template_id AND tv.version = p.template_version
     LEFT JOIN pass_versions pv ON pv.pass_id = p.id AND pv.version = p.version
     WHERE p.deleted_at IS NULL AND (
       p.scan_code IS NULL
       OR (p.barcode_hash IS NULL AND p.removed_at IS NULL AND (
            json_extract(pv.pass_json, '$.barcodes[0].message') IS NOT NULL
            OR json_extract(pv.pass_json, '$.barcode.message') IS NOT NULL))
       OR (p.lookup_hash IS NULL AND json_extract(tv.manifest, '$.scan.lookup.input') IS NOT NULL
           AND json_extract(p.personalization, '$."' || json_extract(tv.manifest, '$.scan.lookup.input') || '"') IS NOT NULL
           AND json_extract(p.personalization, '$."' || json_extract(tv.manifest, '$.scan.lookup.input') || '"') <> '')
     )
     LIMIT ?`,
    [limit],
  );
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const barcodeHash =
      row.barcode_hash === null && row.removed_at === null && row.pass_json
        ? await barcodeHashOf(JSON.parse(row.pass_json))
        : null;
    const value =
      row.lookup_hash === null && row.lookup_input
        ? lookupValueOf(JSON.parse(row.personalization), row.lookup_input)
        : null;
    const lookupHash = value === null ? null : await lookupHashOf(value);
    updates.push(
      stmt(
        db,
        `UPDATE passes SET scan_code = COALESCE(scan_code, ?), barcode_hash = COALESCE(barcode_hash, ?),
           lookup_hash = COALESCE(lookup_hash, ?) WHERE id = ?`,
        [row.scan_code === null ? mintScanCode() : null, barcodeHash, lookupHash, row.id],
      ),
    );
  }
  for (let i = 0; i < updates.length; i += 50) await batch(db, updates.slice(i, i + 50));
  return rows.length;
}
