import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ConnectionMode } from '../../../shared/contracts/connections.ts';
import { all, first } from '../../platform/db.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { HolderConnectionFence, HolderPass } from '../holders/repo.ts';
import { writeSystemValue } from '../settings/repo.ts';
import { providerRetirementCompleteSql } from '../wallet-providers/repo-sync-retention.ts';
import type { TenantPassWrite } from './http.ts';
import type { ConnectionPassContext } from './repo.ts';
import { type FieldSources, mapPass, type Pass, type PassDbRow } from './repo-map.ts';

export type CredentialTransferSource = Pick<
  HolderPass,
  | 'orgId'
  | 'mode'
  | 'holderEmail'
  | 'ownerUserId'
  | 'version'
  | 'revision'
  | 'rowVersion'
  | 'lifecycleGeneration'
  | 'releaseId'
  | 'downloadToken'
  | 'linkGeneration'
> & { credentialGeneration: number };
export type CredentialTransferAuthority =
  | TenantPassWrite
  | {
      kind: 'tenant-holder';
      expected: CredentialTransferSource;
      authority?: TenantPassWrite | undefined;
      audit?: AuditEntry | undefined;
    }
  | {
      kind: 'verified-attach';
      expected: CredentialTransferSource;
      userId: string;
      email: string;
      connection?: HolderConnectionFence | undefined;
      authority?: TenantPassWrite | undefined;
      audit?: AuditEntry | undefined;
    }
  | {
      kind: 'self-remove';
      expected: CredentialTransferSource;
      userId: string;
      /** The owner's session id hash: the grant proves it is still live at commit. */
      sessionId: string;
      audit?: AuditEntry | undefined;
    }
  | {
      kind: 'connection';
      expected: CredentialTransferSource;
      connection: ConnectionPassContext;
      content: ConnectionTransferContent;
      audit?: AuditEntry | undefined;
    };
export interface ConnectionTransferContent {
  personalization: Personalization;
  fieldSources: FieldSources;
}
export interface ConnectionTransferBinding {
  connectionId: string;
  externalRef: string | null;
  generation: number;
  mode: ConnectionMode;
  releaseId: string;
  releaseGeneration: number;
  releaseVersion: string;
}
export interface CredentialTransferTarget {
  holderEmail: string | null;
  ownerUserId: string | null;
}

interface SourceRow extends PassDbRow {
  credential_generation: number;
  lifecycle_generation: number;
  image_generation: number;
  removal_message: string | null;
  removal_prior_status: string | null;
  removal_published_generation: number | null;
  lookup_hash: string | null;
  lookup_input: string | null;
  prior_pass_json: string | null;
  identity_revision: number | null;
  assets_snapshot: string;
  photo_snapshot: string;
}
export interface TransferPass {
  pass: Pass;
  credentialGeneration: number;
  lifecycleGeneration: number;
  imageGeneration: number;
  removalMessage: string | null;
  removalPriorStatus: string | null;
  removalPublishedGeneration: number | null;
  lookupHash: string | null;
  lookupInput: string | null;
  priorPassJson: string | null;
  rawPersonalization: string;
  rawFieldSources: string;
  identityRevision: number;
  assetsSnapshot: string;
  photoSnapshot: string;
}

// Asset staging need not bump a pass version; include every mutable build input in the CAS.
export const assetsSql = `(SELECT json_group_array(json_array(name,r2_key,sha1,size,width,height,crc32,created_at))
  FROM (SELECT * FROM pass_assets WHERE pass_id = p.id ORDER BY name))`;
export const photoSql = `(SELECT json_group_array(json_array(org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at))
  FROM (SELECT * FROM member_photos WHERE pass_id = p.id ORDER BY pass_id))`;

export async function readTransferPass(
  db: D1Database,
  passId: string,
): Promise<TransferPass | null> {
  const row = await first<SourceRow>(
    db,
    `SELECT p.*,
    (SELECT json_extract(tv.manifest, '$.scan.lookup.input') FROM template_versions tv
      WHERE tv.template_id = p.template_id AND tv.version = p.template_version) AS lookup_input,
    (SELECT v.pass_json FROM pass_versions v WHERE v.pass_id = p.id AND v.pass_json IS NOT NULL
      ORDER BY v.version DESC LIMIT 1) AS prior_pass_json,
    (SELECT si.revision FROM signing_identities si WHERE si.id = p.identity_id
      AND (si.org_id IS NULL OR si.org_id = p.org_id)) AS identity_revision,
    ${assetsSql} AS assets_snapshot, ${photoSql} AS photo_snapshot
    FROM passes p WHERE p.id = ?`,
    [passId],
  );
  if (!row || row.identity_revision === null) return null;
  return {
    pass: mapPass(row),
    credentialGeneration: row.credential_generation,
    lifecycleGeneration: row.lifecycle_generation,
    imageGeneration: row.image_generation,
    removalMessage: row.removal_message,
    removalPriorStatus: row.removal_prior_status,
    removalPublishedGeneration: row.removal_published_generation,
    lookupHash: row.lookup_hash,
    lookupInput: row.lookup_input,
    priorPassJson: row.prior_pass_json,
    rawPersonalization: row.personalization,
    rawFieldSources: row.field_sources,
    identityRevision: row.identity_revision,
    assetsSnapshot: row.assets_snapshot,
    photoSnapshot: row.photo_snapshot,
  };
}

export interface TransferRow {
  id: string;
  pass_id: string;
  org_id: string;
  mode: Mode;
  state: 'pending' | 'completed';
  source_generation: number;
  target_generation: number;
  source_version: number;
  source_revision: number;
  /** The pass `row_version` the start was derived from; the guards compare it, not version or revision. */
  source_row_version: number;
  source_lifecycle_generation: number;
  source_link_generation: number;
  target_holder_email: string | null;
  target_owner_user_id: string | null;
  requested_by_type: string;
  requested_by_id: string | null;
  requested_at: number;
  completed_at: number | null;
  source_connection_id: string | null;
  source_connection_ref: string | null;
  source_connection_generation: number | null;
  source_connection_mode: ConnectionMode | null;
  source_admitted_release_id: string | null;
  source_admitted_release_generation: number | null;
  source_admitted_release_version: string | null;
}

export const readCredentialTransfer = (db: D1Database, id: string) =>
  first<TransferRow>(db, 'SELECT * FROM pass_credential_transfers WHERE id = ?', [id]);
export function readTransferConnection(db: D1Database, orgId: string, connectionId: string) {
  return first<{ mode: ConnectionMode; generation: number }>(
    db,
    'SELECT mode, generation FROM connections WHERE id = ? AND org_id = ? AND enabled = 1',
    [connectionId, orgId],
  );
}
export function readTransferPayload(db: D1Database, transferId: string) {
  return first<{
    kek_version: number;
    iv: ArrayBuffer | Uint8Array;
    wrapped_dek: ArrayBuffer | Uint8Array;
    ciphertext: ArrayBuffer | Uint8Array;
  }>(
    db,
    `SELECT kek_version,iv,wrapped_dek,ciphertext
    FROM pass_credential_transfer_payloads WHERE transfer_id = ?`,
    [transferId],
  );
}
export async function unresolvedRetainedClaim(
  db: D1Database,
  passId: string,
  orgId: string,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM connection_webhook_items item
    JOIN connection_webhook_retention retained ON retained.id = item.retention_id
    WHERE item.state IN ('started','uncertain') AND (item.claim_pass_id = ?
      OR (item.claim_prior_unbound = 1 AND retained.org_id = ?)) LIMIT 1`,
      [passId, orgId],
    )) !== null
  );
}
export async function tombstoneExists(
  db: D1Database,
  orgId: string,
  mode: Mode,
  refs: string[],
): Promise<boolean> {
  if (!refs.length) return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM pass_credential_tombstones
    WHERE org_id = ? AND mode = ? AND credential_hash IN (SELECT value FROM json_each(?)) LIMIT 1`,
      [orgId, mode, JSON.stringify(refs)],
    )) !== null
  );
}
export async function retirementComplete(db: D1Database, transfer: TransferRow): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = ? AND p.mode = ?
    AND p.credential_generation = ? AND ${providerRetirementCompleteSql('p.id', 'p.credential_generation')}`,
      [transfer.pass_id, transfer.org_id, transfer.mode, transfer.target_generation],
    )) !== null
  );
}

export type TransferSweepKind = 'pending' | 'attach';
export interface TransferSweepCursor {
  after: string | null;
  upper: string | null;
}
export async function transferResumeCursor(
  db: D1Database,
  kind: TransferSweepKind,
): Promise<TransferSweepCursor> {
  const row = await first<{ value: string }>(
    db,
    `SELECT value FROM settings WHERE scope = 'system' AND key = ?`,
    [`pass.credentialTransferCursor.${kind}`],
  );
  try {
    const value: unknown = row ? JSON.parse(row.value) : null;
    if (
      value &&
      typeof value === 'object' &&
      'after' in value &&
      'upper' in value &&
      typeof value.after === 'string' &&
      typeof value.upper === 'string'
    )
      return { after: value.after, upper: value.upper };
  } catch {
    /* A malformed cursor starts a new bounded cycle. */
  }
  return { after: null, upper: null };
}
export async function saveTransferResumeCursor(
  db: D1Database,
  cursor: TransferSweepCursor,
  now: number,
  kind: TransferSweepKind,
): Promise<void> {
  await writeSystemValue(db, `pass.credentialTransferCursor.${kind}`, cursor, now);
}
/** Freeze a cycle's high-water mark, so a continuous stream of newer IDs cannot starve retries. */
export async function transferSweepUpper(db: D1Database): Promise<string | null> {
  const row = await first<{ id: string | null }>(
    db,
    "SELECT MAX(id) AS id FROM pass_credential_transfers WHERE state = 'pending'",
  );
  return row?.id ?? null;
}
export function listPendingCredentialTransfers(
  db: D1Database,
  cursor: TransferSweepCursor,
  limit: number,
) {
  return all<{ id: string }>(
    db,
    `SELECT id FROM pass_credential_transfers
    WHERE state = 'pending' AND (? IS NULL OR id > ?) AND id <= ? ORDER BY id LIMIT ?`,
    [cursor.after, cursor.after, cursor.upper, limit],
  );
}
