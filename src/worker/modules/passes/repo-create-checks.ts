import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import type { NewPassRow } from './repo-write-types.ts';

/** True when the scan module's sample-scope fence holds right now. */
export async function fenceHolds(
  db: D1Database,
  fence: { sql: string; params: SqlValue[] },
): Promise<boolean> {
  return (await first(db, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params)) !== null;
}

/** The release the pass is built from is still the same generation, version, candidate and provider. */
export function releaseSnapshotCheck(row: NewPassRow): Check {
  return rawCheck(
    'release',
    `EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND r.generation = ?
        AND r.version = ? AND r.candidate_hash IS ? AND r.provider = ?)`,
    [
      row.release.id,
      row.release.generation,
      row.templateVersion,
      row.release.candidateHash,
      row.release.provider,
    ],
  );
}

/** An org release belongs to the grant's org; a platform release has no org. */
export function releaseOrgCheck(release: NewPassRow['release']): Check {
  return tenantCheck(
    'release',
    `EXISTS (SELECT 1 FROM template_releases r WHERE r.id = ? AND ${
      release.orgId === null ? 'r.org_id IS NULL' : 'r.org_id = {org}'
    })`,
    [release.id],
  );
}

export function scannerTemplatesCheck(scannerId: string, templateIds: Iterable<string>): Check {
  return rawCheck(
    'config',
    `(SELECT json_group_array(template_id) FROM
          (SELECT template_id FROM scanner_templates WHERE scanner_id = ? ORDER BY template_id)) = ?`,
    [scannerId, JSON.stringify([...templateIds].sort())],
  );
}

/** The template keeps an effective Apple release head in the grant's mode. */
export function templateHeadCheck(templateId: string, orgId: string): Check {
  return tenantCheck(
    'config',
    `EXISTS (SELECT 1 FROM template_release_heads h JOIN templates owner ON owner.id = h.template_id
            WHERE h.template_id = ? AND h.mode = {mode} AND h.provider = 'apple'
              AND owner.status != 'deleted'
              AND (h.org_scope = ? OR (h.org_scope = '' AND owner.org_id IS NULL AND owner.origin = 'baked')))`,
    [templateId, orgId],
  );
}

export function scannerHasNoDevicesCheck(scannerId: string): Check {
  return rawCheck(
    'config',
    'NOT EXISTS (SELECT 1 FROM scanning_devices d WHERE d.scanner_id = ?)',
    [scannerId],
  );
}
