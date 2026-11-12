import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';
import type { NewPassRow } from './repo-write-types.ts';

const OWNER_SQL = `(SELECT CASE WHEN count(*) = 1 THEN min(u.id) END FROM users u
  WHERE u.status = 'active'
    AND EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ?)
    AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = ? AND b.user_id = u.id))`;

/** The one active user who verified the holder email and is not blocked from this pass, or null. */
export async function attachableOwner(db: D1Database, row: NewPassRow): Promise<string | null> {
  if (!row.holderEmail) return null;
  const found = await first<{ id: string | null }>(db, `SELECT ${OWNER_SQL} AS id`, [
    row.holderEmail,
    row.id,
  ]);
  return found?.id ?? null;
}

/**
 * The pass row, in the create grant. The owner read before the grant is re-proved in the insert, so a
 * user change in between inserts nothing; a credential tombstone of the org and mode does the same.
 * `org_id` and `mode` come from the grant. The `pass_created` trigger records version 1.
 */
export function grantPassInsert(
  g: Grant,
  row: NewPassRow,
  ownerUserId: string | null,
): GrantedStatement {
  return g.insertSelect(
    'passes',
    [
      'id',
      'identity_id',
      'serial',
      'template_id',
      'template_version',
      'release_id',
      'auth_token',
      'download_token',
      'web_service_url',
      'personalization',
      'field_sources',
      'display_title',
      'display_subtitle',
      'external_id',
      'holder_email',
      'owner_user_id',
      'connection_id',
      'external_ref',
      'object_key',
      'object_sha256',
      'object_size',
      'content_hash',
      'modified_at',
      'created_by',
      'created_at',
      'pending_cause',
      'pending_actor_type',
      'pending_actor_id',
      'pending_pass_json',
      'test_data_quarantined',
      'scan_code',
      'barcode_hash',
      'lookup_hash',
    ],
    [
      row.id,
      row.identityId,
      row.serial,
      row.templateId,
      row.templateVersion,
      row.release.id,
      row.authToken,
      row.downloadToken,
      row.webServiceUrl,
      JSON.stringify(row.personalization),
      JSON.stringify(row.fieldSources),
      row.displayTitle,
      row.displaySubtitle,
      row.externalId,
      row.holderEmail,
      ownerUserId,
      row.connectionId,
      row.externalRef,
      row.objectKey,
      row.objectSha256,
      row.objectSize,
      row.contentHash,
      row.now,
      row.createdBy,
      row.now,
      'create',
      row.actorType,
      row.actorId,
      row.passJson,
      0,
      row.scanCode,
      row.barcodeHash,
      row.lookupHash,
    ],
    {
      when: [
        tenantSql(
          `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones dead WHERE dead.org_id = {org}
            AND dead.mode = {mode} AND dead.credential_hash IN (SELECT value FROM json_each(?)))`,
          [JSON.stringify(row.credentialRefs)],
        ),
        tenantSql(`${OWNER_SQL} IS ?`, [row.holderEmail, row.id, ownerUserId]),
      ],
      returning: ['id', 'owner_user_id'],
    },
  );
}
