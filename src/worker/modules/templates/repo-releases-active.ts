import type { SqlValue } from '../../platform/db.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
} from './release-content.ts';
import type { ReleaseScopeSql } from './repo-release-heads.ts';

// The head-by-scan subqueries of the pre-heads design. Scan, connection and pass-write packages still
// call these; each moves to effectiveReleaseIdSql (repo-release-heads.ts) with its own work package.

const quotedCapabilities = `'${JSON.stringify(APPLE_ADAPTER_CAPABILITIES).replace(/'/g, "''")}'`;
/**
 * Correlated, parameter-free lookup: select the head first, then require current provenance.
 * @deprecated Reads the head with a NOT EXISTS subquery. Use `effectiveReleaseIdSql`.
 */
export function activeReleaseIdSql(scope: ReleaseScopeSql): string {
  return `SELECT ar.id FROM template_releases ar JOIN templates at ON at.id = ar.template_id
    JOIN template_versions av ON av.template_id = ar.template_id AND av.version = ar.version
    WHERE (ar.template_id = (${scope.templateIdSql}) AND ar.mode = (${scope.modeSql})
      AND ar.provider = (${scope.providerSql}) AND ar.provider = 'apple')
      AND (at.status = 'active'
        AND ((ar.source IN ('approved', 'legacy') AND at.origin = 'uploaded' AND ar.org_id IS NOT NULL
              AND ar.org_id IS (${scope.orgIdSql}) AND (at.org_id IS NULL OR at.org_id = ar.org_id))
          OR (ar.source = 'system' AND at.origin = 'baked' AND ar.org_id IS at.org_id
            AND (ar.org_id IS (${scope.orgIdSql}) OR (ar.org_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM template_releases exact
                WHERE exact.template_id = ar.template_id AND exact.org_id = (${scope.orgIdSql})
                  AND exact.org_id IS at.org_id AND exact.mode = ar.mode AND exact.provider = ar.provider)))))
        AND NOT EXISTS (SELECT 1 FROM template_releases newer
          WHERE newer.template_id = ar.template_id AND newer.org_id IS ar.org_id
            AND newer.mode = ar.mode AND newer.provider = ar.provider AND newer.generation > ar.generation))
      AND (ar.adapter_revision = ${APPLE_ADAPTER_REVISION} AND ar.adapter_capabilities = ${quotedCapabilities}
        AND ar.audience_policy_revision = ${AUDIENCE_POLICY_REVISION})
      AND ((ar.source = 'system' AND ar.action = 'system' AND at.origin = 'baked'
            AND ar.version = at.active_version AND ar.candidate_id IS NULL AND ar.approval_id IS NULL)
        OR (ar.source = 'legacy' AND ar.action = 'legacy' AND at.origin = 'uploaded'
          AND ar.version = at.active_version)
        OR (ar.source = 'approved' AND ar.action IN ('release', 'rollback') AND at.origin = 'uploaded'
          AND EXISTS (SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
            WHERE (c.id = ar.candidate_id AND a.id = ar.approval_id AND c.template_id = ar.template_id
                AND c.org_id IS ar.org_id)
              AND (c.mode = ar.mode AND c.provider = ar.provider AND c.version = ar.version
                AND c.candidate_hash = ar.candidate_hash)
              AND (a.candidate_hash = c.candidate_hash AND c.content_hash = ar.content_hash
                AND c.adapter_revision = ar.adapter_revision AND c.adapter_capabilities = ar.adapter_capabilities)
              AND (c.audience_policy_revision = ar.audience_policy_revision
                AND av.created_by IS c.version_author_id AND a.reviewer_id != c.author_id
                AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)))))
    LIMIT 1`;
}
/** Trusted SQL expressions for validating many captured bindings with a single JSON parameter. */
interface ReleaseBindingSql {
  idSql: string;
  generationSql: string;
  versionSql: string;
  candidateHashSql: string;
  orgIdSql?: string;
  providerSql?: string;
}

function activeReleaseBindingPredicate(binding: ReleaseBindingSql, scope: ReleaseScopeSql): string {
  const filters = [
    `(bound_release.id = (${binding.idSql}) AND bound_release.generation = (${binding.generationSql})
      AND bound_release.version = (${binding.versionSql})
      AND bound_release.candidate_hash = (${binding.candidateHashSql}))`,
  ];
  if (binding.orgIdSql !== undefined) filters.push(`bound_release.org_id IS (${binding.orgIdSql})`);
  if (binding.providerSql !== undefined)
    filters.push(`bound_release.provider = (${binding.providerSql})`);
  // Scope the immutable snapshot separately from the active head to keep D1 expression depth bounded.
  return `EXISTS (
    SELECT bound_release.id FROM template_releases bound_release WHERE ${filters.join(' AND ')}
    INTERSECT ${activeReleaseIdSql(scope)}
  )`;
}

interface ReleaseBinding {
  id: string;
  generation: number;
  version: string;
  candidateHash: string;
  orgId?: string | null;
  provider?: 'apple';
}
/** Revalidate an evaluated release in the same D1 statement as a dependent read or write. */
export function activeReleasePredicate(
  binding: ReleaseBinding,
  scope: ReleaseScopeSql,
): { sql: string; params: SqlValue[] } {
  const expressions: ReleaseBindingSql = {
    idSql: '?',
    generationSql: '?',
    versionSql: '?',
    candidateHashSql: '?',
  };
  const params: SqlValue[] = [
    binding.id,
    binding.generation,
    binding.version,
    binding.candidateHash,
  ];
  if (binding.orgId !== undefined) {
    expressions.orgIdSql = '?';
    params.push(binding.orgId);
  }
  if (binding.provider !== undefined) {
    expressions.providerSql = '?';
    params.push(binding.provider);
  }
  return { sql: activeReleaseBindingPredicate(expressions, scope), params };
}
