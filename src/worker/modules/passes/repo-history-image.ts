import { batch, first, run, stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import type { Pass } from './repo-map.ts';

export function imagePassWhere(authority?: TenantPassWrite, imageGeneration?: number): string {
  return `p.id = ? AND p.org_id = ? AND p.mode = ? AND p.identity_id = ?
    AND p.version = ? AND p.revision = ? AND p.template_id = ? AND p.template_version = ?
    AND p.release_id IS ? AND p.serial = ? AND p.auth_token = ? AND p.download_token = ?
    AND p.holder_email IS ? AND p.owner_user_id IS ? AND p.link_generation = ?
    AND p.credential_generation = ? AND p.lifecycle_generation = ? AND p.status = ?
    AND p.removed_at IS ? AND p.connection_id IS ? AND p.external_ref IS ?
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')${
      authority ? ` AND ${tenantPassAuthoritySql(authority, 'p')} AND p.mode = ?` : ''
    }${imageGeneration === undefined ? '' : ' AND p.image_generation = ?'}`;
}

export function imagePassParams(
  pass: Pass,
  now: number,
  authority?: TenantPassWrite,
  imageGeneration?: number,
) {
  return [
    pass.id,
    pass.orgId,
    pass.mode,
    pass.identityId,
    pass.version,
    pass.revision,
    pass.templateId,
    pass.templateVersion,
    pass.releaseId,
    pass.serial,
    pass.authToken,
    pass.downloadToken,
    pass.holderEmail,
    pass.ownerUserId,
    pass.linkGeneration,
    pass.credentialGeneration,
    pass.lifecycleGeneration,
    pass.status,
    pass.removedAt,
    pass.connectionId,
    pass.externalRef,
    ...(authority ? [...tenantPassAuthorityParams(authority, now), authority.mode] : []),
    ...(imageGeneration === undefined ? [] : [imageGeneration]),
  ];
}

export function imageAuthorityMatches(pass: Pass, authority?: TenantPassWrite): boolean {
  return (
    !authority ||
    (authority.orgId === pass.orgId &&
      authority.mode === pass.mode &&
      (authority.kind === 'session'
        ? authority.capability === 'passes:operate'
        : authority.scope === 'passes:write'))
  );
}

/** Capture the image epoch only if the previously read pass and authority are still exact. */
export async function capturePassImageGeneration(
  db: D1Database,
  pass: Pass,
  now: number,
  authority?: TenantPassWrite,
): Promise<number | null> {
  if (!imageAuthorityMatches(pass, authority)) return null;
  const row = await first<{ image_generation: number }>(
    db,
    `SELECT p.image_generation FROM passes p WHERE ${imagePassWhere(authority)}`,
    imagePassParams(pass, now, authority),
  );
  return row?.image_generation ?? null;
}

/** Recheck the exact pass, image epoch and grant around image I/O. */
export async function passImageWriteCurrent(
  db: D1Database,
  pass: Pass,
  now: number,
  authority?: TenantPassWrite,
  imageGeneration?: number,
): Promise<boolean> {
  if (!imageAuthorityMatches(pass, authority)) return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM passes p WHERE ${imagePassWhere(authority, imageGeneration)}`,
      imagePassParams(pass, now, authority, imageGeneration),
    )) !== null
  );
}

/** Reserve the fresh key and source generation before any R2 PUT can be issued. */
export async function reservePassImageUpload(
  db: D1Database,
  pass: Pass,
  key: string,
  imageGeneration: number,
  now: number,
  authority?: TenantPassWrite,
): Promise<boolean> {
  if (!imageAuthorityMatches(pass, authority)) return false;
  const result = await run(
    db,
    `INSERT INTO pass_transfer_asset_uploads
    (r2_key,pass_id,credential_generation,lifecycle_generation,link_generation,pass_version,pass_revision,created_at)
    SELECT ?,p.id,p.credential_generation,p.lifecycle_generation,p.link_generation,p.version,p.revision,?
    FROM passes p WHERE ${imagePassWhere(authority, imageGeneration)}`,
    [key, now, ...imagePassParams(pass, now, authority, imageGeneration)],
  );
  return result.changes === 1;
}

/** A rejected conditional PUT never owned the existing R2 object. */
export async function cancelPassImageUpload(
  db: D1Database,
  passId: string,
  key: string,
): Promise<void> {
  await run(
    db,
    `DELETE FROM pass_transfer_asset_uploads WHERE pass_id = ? AND r2_key = ?
    AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
      WHERE t.pass_id = pass_transfer_asset_uploads.pass_id AND t.state = 'pending')`,
    [passId, key],
  );
}

export interface ImageMutationResult {
  saved: boolean;
  candidateId: number | null;
  imageGeneration: number | null;
}

/** An upload CAS requires its exact still-live pre-PUT reservation. */
export function imageUploadWhere(key: string | undefined): string {
  return key === undefined
    ? ''
    : ` AND EXISTS (SELECT 1 FROM pass_transfer_asset_uploads u
    WHERE u.r2_key = ? AND u.pass_id = ? AND u.credential_generation = ?
      AND u.lifecycle_generation = ? AND u.link_generation = ? AND u.pass_version = ? AND u.pass_revision = ?)`;
}

export function imageUploadParams(pass: Pass, key: string | undefined) {
  return key === undefined
    ? []
    : [
        key,
        pass.id,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        pass.linkGeneration,
        pass.version,
        pass.revision,
      ];
}

/** A rollback may restore only the key protected by this exact outstanding hold. */
export function imageCandidateWhere(candidateId: number | undefined): string {
  return candidateId === undefined
    ? ''
    : ` AND EXISTS (SELECT 1 FROM pass_transfer_asset_candidates c
    WHERE c.id = ? AND c.pass_id = ? AND c.r2_key = ? AND c.kind = ? AND c.slot = ?)`;
}

export function imageCandidateParams(
  candidateId: number | undefined,
  passId: string,
  key: string | undefined,
  kind: 'asset' | 'photo',
  slot: string,
) {
  return candidateId === undefined ? [] : [candidateId, passId, key, kind, slot];
}

/** Commit the row, invalidate link snapshots, and capture this mutation's rollback hold. */
export async function commitImageMutation(
  db: D1Database,
  mutation: D1PreparedStatement,
  pass: Pass,
  imageGeneration: number,
  hasPrevious: boolean,
  kind: 'asset' | 'photo',
  slot: string,
): Promise<ImageMutationResult> {
  const [row, advanced, candidate] = await batch(db, [
    mutation,
    stmt(
      db,
      `UPDATE passes SET link_generation = link_generation + 1
      WHERE id = ? AND org_id = ? AND link_generation = ? AND version = ?
        AND image_generation = ? AND changes() = 1
      RETURNING image_generation`,
      [pass.id, pass.orgId, pass.linkGeneration, pass.version, imageGeneration + 1],
    ),
    !hasPrevious
      ? stmt(db, 'SELECT NULL AS id')
      : stmt(
          db,
          `SELECT id FROM pass_transfer_asset_candidates
          WHERE pass_id = ? AND kind = ? AND slot = ? ORDER BY id DESC LIMIT 1`,
          [pass.id, kind, slot],
        ),
  ]);
  if (row?.results.length !== 1 || advanced?.results.length !== 1)
    return { saved: false, candidateId: null, imageGeneration: null };
  const image = advanced.results[0] as { image_generation: number };
  const candidateId = (candidate?.results[0] as { id: number | null } | undefined)?.id ?? null;
  if (hasPrevious && candidateId === null) throw new Error('Missing image rollback candidate.');
  return { saved: true, candidateId, imageGeneration: image.image_generation };
}
