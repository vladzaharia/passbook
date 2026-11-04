import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { first, run } from '../../platform/db.ts';
import type { FieldSources, PassCause, PassStatus } from './repo-map.ts';

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
  contentHash: string;
  now: number;
  createdBy: string | null;
  passJson: string;
  actorType: string | null;
  actorId: string | null;
  mode: Mode;
  scanCode: string;
  barcodeHash: string | null;
}

/** The `pass_created` trigger records version 1 from the pending_* columns. */
export async function insertPass(db: D1Database, row: NewPassRow): Promise<void> {
  await run(
    db,
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
       web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email,
       connection_id, external_ref, object_key, object_sha256, object_size, content_hash, modified_at, created_by, created_at,
       pending_cause, pending_actor_type, pending_actor_id, pending_pass_json, mode, scan_code, barcode_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?, ?)`,
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
  contentHash: string;
  cause: PassCause;
  /** Why beside the cause (scan, broadcast, ...); copied to pass_versions.source by the trigger. */
  source: PassSource | null;
  actorType: string | null;
  actorId: string | null;
  passJson: string;
  barcodeHash: string | null;
  /** Written only while the pass has none (lazy backfill). */
  scanCode: string;
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
       content_hash = ?, modified_at = ?, modified_collision = ?, version = version + 1, sync_error_code = NULL,
       pending_cause = ?, pending_actor_type = ?, pending_actor_id = ?, pending_pass_json = ?,
       pending_source = ?, barcode_hash = ?, scan_code = COALESCE(scan_code, ?)
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
      w.contentHash,
      w.now,
      sameSecond ? 1 : 0,
      w.cause,
      w.actorType,
      w.actorId,
      w.passJson,
      w.source,
      w.barcodeHash,
      w.scanCode,
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
  set: {
    fieldSources: FieldSources;
    externalId: string | null;
    templateVersion: string;
    contentHash: string;
    barcodeHash: string | null;
    scanCode: string;
  },
): Promise<number | null> {
  const row = await first<{ version: number }>(
    db,
    `UPDATE passes SET field_sources = ?, external_id = ?, template_version = ?, content_hash = ?,
       barcode_hash = ?, scan_code = COALESCE(scan_code, ?), version = version + 1
     WHERE id = ? AND version = ? RETURNING version`,
    [
      JSON.stringify(set.fieldSources),
      set.externalId,
      set.templateVersion,
      set.contentHash,
      set.barcodeHash,
      set.scanCode,
      id,
      expectedVersion,
    ],
  );
  return row?.version ?? null;
}

/** Binds or unbinds a connection ref. Throws the raw UNIQUE error when another pass holds the ref. */
export async function setBinding(
  db: D1Database,
  id: string,
  binding: { connectionId: string | null; externalRef: string | null; fieldSources: FieldSources },
): Promise<void> {
  await run(
    db,
    `UPDATE passes SET connection_id = ?, external_ref = ?, field_sources = ?, sync_error_code = NULL
     WHERE id = ?`,
    [binding.connectionId, binding.externalRef, JSON.stringify(binding.fieldSources), id],
  );
}
