import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
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
  linkGeneration: number;
  webServiceUrl: string;
  personalization: Personalization;
  fieldSources: FieldSources;
  displayTitle: string | null;
  displaySubtitle: string | null;
  externalId: string | null;
  holderEmail: string | null;
  ownerUserId: string | null;
  status: PassStatus;
  /** Set from the creator's mode and never changed. */
  mode: Mode;
  /** Legacy Test data is unavailable until explicitly remediated. */
  testDataQuarantined: boolean;
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
  /** Unguessable scan identifier; null until the first publish after it was introduced. */
  scanCode: string | null;
  /** SHA-256 hex of the primary barcode message at the last publish. */
  barcodeHash: string | null;
  /** Set when the pass was removed from Wallet; cleared on restore. */
  removedAt: number | null;
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
  link_generation: number;
  web_service_url: string;
  personalization: string;
  field_sources: string;
  display_title: string | null;
  display_subtitle: string | null;
  external_id: string | null;
  holder_email: string | null;
  owner_user_id: string | null;
  status: PassStatus;
  mode: Mode;
  test_data_quarantined: number;
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
  scan_code: string | null;
  barcode_hash: string | null;
  removed_at: number | null;
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
    linkGeneration: row.link_generation,
    webServiceUrl: row.web_service_url,
    personalization: JSON.parse(row.personalization) as Personalization,
    fieldSources: JSON.parse(row.field_sources) as FieldSources,
    displayTitle: row.display_title,
    displaySubtitle: row.display_subtitle,
    externalId: row.external_id,
    holderEmail: row.holder_email,
    ownerUserId: row.owner_user_id,
    status: row.status,
    mode: row.mode,
    testDataQuarantined: row.test_data_quarantined !== 0,
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
    scanCode: row.scan_code,
    barcodeHash: row.barcode_hash,
    removedAt: row.removed_at,
    createdAt: row.created_at,
    deviceCount: row.device_count ?? 0,
    orgSlug: row.org_slug ?? null,
  };
}
