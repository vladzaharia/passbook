import { grant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

/**
 * Workbench Simulate: a Test email that was captured is marked failed. A grant of the caller's own
 * authority, pinned to a Test pass of its org and to the captured (`sent`, `TEST_MODE`) email row of
 * that pass. False when the row is not one of those.
 */
export async function failCapturedEmail(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  passId: string,
  outboxId: string,
  code: string,
): Promise<boolean> {
  const g = grant(ctx, {
    purpose: 'org_mode.pass.simulate_email',
    principal: tenantPrincipal(authority),
    target: passId,
    checks: [
      ...capabilityChecks(authority),
      rowIs('passes', passId, { test_data_quarantined: 0, deleted_at: null }, 'lineage'),
    ],
    codes: { lineage: 'SIMULATE_TEST_ONLY' },
  });
  g.update('outbox', {
    set: { state: 'failed', error_code: code, finished_at: ctx.clock.now() },
    where: { id: outboxId, pass_id: passId, kind: 'email', state: 'sent', error_code: 'TEST_MODE' },
    require: 'one',
  });
  try {
    await g.commit();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status === 409) return false;
    throw error;
  }
}
