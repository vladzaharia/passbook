import { TEMPLATE_SYNC_TABLES } from '../../jobs/template-sync-tables.ts';
import { first, type SqlValue, stmt } from '../../platform/db.ts';
import type { AssetDigest } from './release-content.ts';

export interface VersionHashes {
  contentHash: string;
  assetHashes: AssetDigest[];
}

export async function getVersionHashes(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<VersionHashes | null> {
  const found = await first<{ contentHash: string; assetHashes: string }>(
    db,
    `SELECT content_hash AS contentHash, asset_hashes AS assetHashes
     FROM template_version_hashes WHERE template_id = ? AND version = ?`,
    [templateId, version],
  );
  return found
    ? {
        contentHash: found.contentHash,
        assetHashes: JSON.parse(found.assetHashes) as AssetDigest[],
      }
    : null;
}

/**
 * Tables the baked-template sync writes. Template reads (`loadTemplate`, registry, preview) run it on
 * first use per isolate: it is idempotent and system-owned (`platform.job.template_sync`), settles once
 * per build, and never fails the read (a refused sync is retried once, then skipped for 30 seconds).
 */
const BAKED_SYNC_TABLES = [...TEMPLATE_SYNC_TABLES, 'audit_log'] as const;

/**
 * Read paths that may write: the first issuance of a release made before hashes were saved stores its
 * write-once, content-derived row (skipping it would re-read every asset on each display GET).
 * @public Imported by WP7's read-path write corpus test.
 */
export const READ_PATH_WRITE_ALLOWLIST = ['template_version_hashes', ...BAKED_SYNC_TABLES] as const;

export interface SqlText {
  sql: string;
  params: SqlValue[];
}

/**
 * Write once: an existing row is left alone (callers compare it first). Must follow the version insert.
 * With `candidateId` the row is written only if that candidate was inserted in the same batch.
 */
export function versionHashesSql(
  templateId: string,
  version: string,
  hashes: VersionHashes,
  now: number,
  candidateId?: string,
): SqlText {
  return {
    sql: `INSERT INTO template_version_hashes (template_id, version, content_hash, asset_hashes, created_at)
     SELECT v.template_id, v.version, ?, ?, ? FROM template_versions v
     WHERE v.template_id = ? AND v.version = ?
       AND NOT EXISTS (SELECT 1 FROM template_version_hashes h
         WHERE h.template_id = v.template_id AND h.version = v.version)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = ?))`,
    params: [
      hashes.contentHash,
      JSON.stringify(hashes.assetHashes),
      now,
      templateId,
      version,
      candidateId ?? null,
      candidateId ?? null,
    ],
  };
}

export function insertVersionHashesStmt(
  db: D1Database,
  templateId: string,
  version: string,
  hashes: VersionHashes,
  now: number,
  candidateId?: string,
): D1PreparedStatement {
  const { sql, params } = versionHashesSql(templateId, version, hashes, now, candidateId);
  return stmt(db, sql, params);
}
