import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { resendEmail } from './pass-service-delivery.ts';
import { removePass } from './remove.ts';
import type { Pass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { type ScopeArg, scopeOrg } from './scope.ts';
import { type Actor, voidPass } from './service.ts';

export interface BulkPassAction {
  action: 'void' | 'send_email' | 'remove';
  message?: string | undefined;
  ids: string[];
  orgId?: string;
}

export interface BulkPassSelection {
  orgId: string;
  passes: Pass[];
}

/** Resolve every id before authorizing or mutating any pass. */
export async function selectBulkPasses(
  ctx: ServiceContext,
  input: BulkPassAction,
  scope: ScopeArg,
): Promise<BulkPassSelection> {
  const pinned = scopeOrg(scope) ?? input.orgId ?? null;
  const readScope =
    typeof scope === 'object' && scope !== null ? { ...scope, orgId: pinned } : pinned;
  const ids = [...new Set(input.ids)];
  const rows = await Promise.all(ids.map((id) => getPass(ctx.env.DB, id, readScope)));
  const passes = rows.filter((pass): pass is Pass => pass !== null);
  const first = passes[0];
  if (!first || passes.length !== ids.length)
    throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
  const orgId = first.orgId;
  if (passes.some((pass) => pass.orgId !== orgId))
    throw new ValidationError('Choose passes of one organization.', [], 'ORG_MIXED');
  return { orgId, passes };
}

/**
 * Applies one action to up to 100 passes of one org, each audited as its own action. Every id must
 * exist in that org (the key's scope, the caller's `orgId`, or the one org the passes share);
 * otherwise nothing runs. Passes of another session mode are skipped as MODE_MISMATCH.
 */
export async function bulkPassAction(
  ctx: ServiceContext,
  actor: Actor,
  input: BulkPassAction,
  scope: ScopeArg,
  authority?: TenantPassWrite,
  selection?: BulkPassSelection,
  onQueued?: () => void,
): Promise<{ done: number; skipped: { id: string; code: string }[] }> {
  const { orgId, passes } = selection ?? (await selectBulkPasses(ctx, input, scope));
  if (
    authority &&
    (authority.orgId !== orgId ||
      typeof scope !== 'object' ||
      scope === null ||
      authority.mode !== scope.mode)
  ) {
    throw new ForbiddenError();
  }
  // Keep all subsequent service reads pinned to the organization actually selected.
  const pinnedScope = typeof scope === 'object' && scope !== null ? { ...scope, orgId } : orgId;
  const mode = typeof scope === 'object' && scope !== null ? scope.mode : null;
  let done = 0;
  const skipped: { id: string; code: string }[] = [];
  for (const pass of passes) {
    if (mode !== null && pass.mode !== mode) {
      skipped.push({ id: pass.id, code: 'MODE_MISMATCH' });
      continue;
    }
    if (input.action === 'void') {
      if (pass.removedAt !== null) {
        skipped.push({ id: pass.id, code: 'PASS_REMOVED' });
        continue;
      }
      if (pass.status === 'active') await voidPass(ctx, actor, pass.id, pinnedScope, authority);
      done++;
    } else if (input.action === 'remove') {
      await removePass(ctx, actor, pass.id, { message: input.message }, pinnedScope, authority);
      done++;
    } else if (pass.removedAt !== null) {
      skipped.push({ id: pass.id, code: 'PASS_REMOVED' });
    } else if (!pass.holderEmail) {
      skipped.push({ id: pass.id, code: 'NO_RECIPIENT' });
    } else {
      try {
        await resendEmail(ctx, actor, pass.id, {}, pinnedScope, authority);
        done++;
        onQueued?.();
      } catch (error) {
        // One refused pass (capped, changed, revoked) must not hide the passes already queued.
        if (!(error instanceof AppError)) throw error;
        skipped.push({ id: pass.id, code: error.code });
      }
    }
  }
  ctx.log.info('passes.bulk_action', {
    orgId,
    action: input.action,
    done,
    skipped: skipped.length,
  });
  return { done, skipped };
}
