import { first } from '../../platform/db.ts';
import type { Pass } from '../passes/repo.ts';

/** Check the complete bearer/owner, credential and artifact snapshot in one D1 read. */
export function currentPublicGeneration(
  db: D1Database,
  pass: Pass,
): Promise<{ linkGeneration: number; credentialGeneration: number } | null> {
  return first<{ link_generation: number; credential_generation: number }>(
    db,
    `SELECT p.link_generation, p.credential_generation FROM passes p JOIN orgs o ON o.id = p.org_id
     WHERE p.id = ? AND p.org_id = ? AND p.download_token = ? AND p.owner_user_id IS ?
       AND p.link_generation = ? AND p.credential_generation = ?
       AND p.holder_email IS ? AND p.mode = ? AND p.template_id = ? AND p.template_version = ?
       AND p.version = ? AND p.revision = ? AND p.object_key = ?
       AND p.object_sha256 IS ? AND p.status = ? AND p.removed_at IS ? AND p.deleted_at IS NULL
       AND p.scan_code IS ? AND p.barcode_hash IS ?
       AND p.test_data_quarantined = 0 AND o.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')`,
    [
      pass.id,
      pass.orgId,
      pass.downloadToken,
      pass.ownerUserId,
      pass.linkGeneration,
      pass.credentialGeneration,
      pass.holderEmail,
      pass.mode,
      pass.templateId,
      pass.templateVersion,
      pass.version,
      pass.revision,
      pass.objectKey,
      pass.objectSha256,
      pass.status,
      pass.removedAt,
      pass.scanCode,
      pass.barcodeHash,
    ],
  ).then((row) =>
    row
      ? {
          linkGeneration: row.link_generation,
          credentialGeneration: row.credential_generation,
        }
      : null,
  );
}

/** Metadata-only pass revisions may have no matching version row. */
export async function passJsonAtVersion(
  db: D1Database,
  passId: string,
  version: number,
): Promise<string | null> {
  const row = await first<{ pass_json: string | null }>(
    db,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version <= ? ORDER BY version DESC LIMIT 1',
    [passId, version],
  );
  return row?.pass_json ?? null;
}

export async function getPassAsset(
  db: D1Database,
  passId: string,
  name: string,
): Promise<{ r2Key: string; sha1: string } | null> {
  const row = await first<{ r2_key: string; sha1: string }>(
    db,
    'SELECT r2_key, sha1 FROM pass_assets WHERE pass_id = ? AND name = ?',
    [passId, name],
  );
  return row ? { r2Key: row.r2_key, sha1: row.sha1 } : null;
}
