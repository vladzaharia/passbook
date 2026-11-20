import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { withinLimit } from '../../platform/entitlements.ts';
import type { NewPassRow } from './repo-write-types.ts';

/** The mode's pass cap (`passes.live`, `passes.test`) over the passes the org holds: removed ones free their slot. */
export const passLimit = (mode: 'live' | 'test'): Check =>
  withinLimit(
    mode === 'live' ? 'passes.live' : 'passes.test',
    `SELECT COUNT(*) FROM passes p WHERE p.org_id = {org} AND p.mode = {mode}
      AND p.removed_at IS NULL AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`,
  );

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

/** The template is not a blueprint: the release head may serve old passes, never a new one. */
export function notBlueprintCheck(templateId: string): Check {
  return rawCheck(
    'release',
    'NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = ? AND t.blueprint = 1)',
    [templateId],
  );
}
