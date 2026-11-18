import { FORK_STALE } from '../modules/templates/repo-fork-update-checks.ts';
import { type Grant, jobGrant } from '../platform/authority.ts';
import type { Check } from '../platform/authority-checks.ts';
import type { ServiceContext } from '../platform/service-context.ts';

/** Every table a fork update writes. The version row and its hashes are parts; the rest are typed. */
export const TEMPLATE_MERGE_TABLES = [
  'template_versions',
  'template_version_hashes',
  'template_candidates',
  'template_version_bases',
  'template_fork_updates',
  'audit_log',
] as const;

const CODES = { stale: FORK_STALE, lineage: FORK_STALE, config: FORK_STALE, release: FORK_STALE };

/**
 * The `system:template-merge` grant of one fork's update: fixed purpose, held in the fork's own org
 * (so the org must be active, and every tenant column comes from it) and limited to the tables above.
 * `tools/authority-scope.ts` allows only `templates/fork-updates-write.ts` to import it.
 */
export function templateMergeGrant(
  ctx: ServiceContext,
  orgId: string,
  input: { checks: Check[]; target?: string },
): Grant {
  return jobGrant(ctx, {
    job: 'template-merge',
    purpose: 'org.job.template_merge',
    orgId,
    codes: CODES,
    tables: TEMPLATE_MERGE_TABLES,
    checks: input.checks,
    ...(input.target === undefined ? {} : { target: input.target }),
  });
}
