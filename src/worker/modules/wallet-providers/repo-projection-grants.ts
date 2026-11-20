import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { templateGrant } from '../templates/repo-grants.ts';
import type { ProjectionAuthority } from './projection-system-authority.ts';

export type ProjectionAction = 'candidate' | 'approve' | 'release';

const CAPABILITY = {
  candidate: 'templates:author',
  approve: 'templates:review',
  release: 'templates:publish',
} as const;

/** A refused write is a concurrent change: the same 409 the service has always raised. */
const CODES = {
  lineage: 'WALLET_PROJECTION_CONFLICT',
  stale: 'WALLET_PROJECTION_CONFLICT',
  config: 'WALLET_PROJECTION_CONFLICT',
  release: 'WALLET_PROJECTION_CONFLICT',
};

const SYSTEM_TABLES = ['template_candidates', 'template_approvals', 'template_releases'];

/**
 * The grant of one provider-projection write. A member holds `org.template.provider_<action>` with the
 * capability captured when the request began; the platform job holds `org.job.wallet.projection_<action>`
 * and acts for its org only while the org is active. Null: the authority cannot do this write (wrong
 * capability, mode or role), which the caller reports as a refused write.
 */
export function projectionGrant(
  ctx: ServiceContext,
  authority: ProjectionAuthority,
  action: ProjectionAction,
  mode: Mode,
  target: string,
  checks: Check[],
): Grant | null {
  if (authority.kind === 'system') {
    const role = action === 'candidate' ? 'author' : 'reviewer';
    if (authority.mode !== mode || authority.role !== role) return null;
    return jobGrant(ctx, {
      job: 'wallet-projection',
      orgId: authority.orgId,
      mode,
      purpose: `org.job.wallet.projection_${action}`,
      target,
      codes: CODES,
      checks,
      tables: SYSTEM_TABLES,
    });
  }
  if (
    authority.kind !== 'session' ||
    authority.capability !== CAPABILITY[action] ||
    authority.mode !== mode
  )
    return null;
  return templateGrant(ctx, authority, `provider_${action}`, { target, codes: CODES, checks });
}
