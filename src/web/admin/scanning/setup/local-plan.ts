// The stand-in for the server's dry run. S3 adds POST /scanning-sessions/setup; then delete this
// file and the localPreview call in api.ts.
import type { ScanSetupIntent } from '@/shared/contracts/scan-setup-intent.ts';
import { planScanSetup } from '@/shared/scan-setup-plan.ts';
import type { SetupIssue } from '@/shared/scan-setup-plan-derive.ts';
import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import { isApiError } from '@/web/lib/errors.ts';
import type { SetupPreview } from './types.ts';

/** The planner refused the answers. */
export class SetupIssuesError extends Error {
  readonly issues: SetupIssue[];
  constructor(issues: SetupIssue[]) {
    super('The answers do not make a setup.');
    this.name = 'SetupIssuesError';
    this.issues = issues;
  }
}

/** A 404 means the route is not deployed yet: plan here. Anything else is the server's answer. */
export function localPreview(
  error: unknown,
  intent: ScanSetupIntent,
  ctx: SetupPlanContext,
): SetupPreview {
  if (!isApiError(error) || error.status !== 404) throw error;
  const result = planScanSetup(intent, ctx);
  if (!result.ok) throw new SetupIssuesError(result.issues);
  return { plan: result.plan, source: 'local' };
}
