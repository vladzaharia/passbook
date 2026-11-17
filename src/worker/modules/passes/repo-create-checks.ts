import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { NewPassRow } from './repo-write-types.ts';

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
