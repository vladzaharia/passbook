import { type Grant, type GrantedStatement, grant } from '../../platform/authority.ts';
import { type Check, passRow, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { capabilityChecks, tenantPrincipal } from './repo-authority.ts';
import type { Pass } from './repo-map.ts';

/** The stale and lineage refusals a caller answers by re-reading, never as a failure. */
export const PASS_LOST = 'PASS_CONFLICT';

export function permitsPassWrite(authority: TenantPassWrite): boolean {
  return authority.kind === 'session'
    ? authority.capability === 'passes:operate'
    : authority.scope === 'passes:write';
}

export const noPendingTransfer = (id: string) =>
  rawCheck(
    'lineage',
    "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
    [id],
  );

/** A tenant grant on one pass: the principal is live and holds the capability, plus the caller's checks. */
export function tenantPassGrant(
  ctx: ServiceContext,
  purpose: string,
  authority: TenantPassWrite,
  passId: string,
  checks: Check[],
  tables?: string[],
): Grant {
  return grant(ctx, {
    purpose,
    principal: tenantPrincipal(authority),
    target: passId,
    checks: [...capabilityChecks(authority), ...checks],
    codes: { stale: PASS_LOST, lineage: PASS_LOST },
    ...(tables ? { tables } : {}),
  });
}

/**
 * A tenant write to one pass: the row is the one read (`stale`), its generations are unchanged and no
 * transfer is pending (`lineage`).
 */
export function passWriteGrant(
  ctx: ServiceContext,
  purpose: string,
  authority: TenantPassWrite,
  pass: Pass,
  tables?: string[],
): Grant {
  return tenantPassGrant(
    ctx,
    purpose,
    authority,
    pass.id,
    [
      ...passRow(pass.id, pass.rowVersion),
      rowIs(
        'passes',
        pass.id,
        {
          credential_generation: pass.credentialGeneration,
          lifecycle_generation: pass.lifecycleGeneration,
          link_generation: pass.linkGeneration,
          test_data_quarantined: 0,
          deleted_at: null,
        },
        'lineage',
      ),
      noPendingTransfer(pass.id),
    ],
    tables,
  );
}

/**
 * Commits a grant whose first statement (or `at`) returns rows; a lost race is `null`, every other
 * refusal throws.
 */
export async function commitRows<T>(g: Grant, at?: GrantedStatement): Promise<T[] | null> {
  try {
    const results = await g.commit();
    const result = results[at ? g.indexOf(at) : 0];
    return (result?.results as T[] | undefined) ?? [];
  } catch (error) {
    if (error instanceof AppError && error.code === PASS_LOST) return null;
    throw error;
  }
}
