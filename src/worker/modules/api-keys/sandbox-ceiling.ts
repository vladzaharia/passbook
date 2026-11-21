import { SANDBOX_KEY_SCOPES } from '../../../shared/contracts/developer-home.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { orgIsDeveloper } from '../orgs/repo-entitlements.ts';

/**
 * A developer org's key holds the sandbox ceiling: never key minting, a terminal's scope or scanning setup. Mint
 * and rotation both call this (the trigger in 0183 is the second line). The refusal names the scopes.
 */
export async function assertSandboxCeiling(
  db: D1Database,
  orgId: string | null,
  scopes: readonly string[],
): Promise<void> {
  if (orgId === null) return;
  const over = scopes.filter((s) => !(SANDBOX_KEY_SCOPES as readonly string[]).includes(s));
  if (over.length === 0 || !(await orgIsDeveloper(db, orgId))) return;
  throw new ForbiddenError(
    `A sandbox key cannot hold ${over.join(', ')}.`,
    'API_KEY_SCOPE_EXCEEDS_SANDBOX',
    {
      issues: over.map((s) => ({ path: 'scopes', message: `${s} is not available in a sandbox.` })),
    },
  );
}
