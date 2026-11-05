import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { removePass } from './remove.ts';
import { getPass } from './repo.ts';
import { type ScopeArg, scopeOrg } from './scope.ts';
import { type Actor, resendEmail, voidPass } from './service.ts';

export interface BulkPassAction {
  action: 'void' | 'send_email' | 'remove';
  message?: string | undefined;
  ids: string[];
  orgId?: string;
}

/**
 * Applies one action to up to 100 passes of one org, each audited as its own action. Every id must
 * exist in that org (the key's scope, the admin's `orgId`, or the one org the passes share);
 * otherwise nothing runs. Passes of the
 * other mode are skipped and reported as MODE_MISMATCH.
 */
export async function bulkPassAction(
  ctx: ServiceContext,
  actor: Actor,
  input: BulkPassAction,
  scope: ScopeArg,
): Promise<{ done: number; skipped: { id: string; code: string }[] }> {
  const pinned = scopeOrg(scope) ?? input.orgId ?? null;
  const mode = typeof scope === 'object' && scope !== null ? scope.mode : null;
  const ids = [...new Set(input.ids)];
  const passes = await Promise.all(ids.map((id) => getPass(ctx.env.DB, id, pinned)));
  if (passes.some((p) => p === null))
    throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
  // Without an org the selection decides it, and it must be one.
  const orgs = new Set(passes.map((p) => p?.orgId));
  if (orgs.size > 1)
    throw new ValidationError('Choose passes of one organization.', [], 'ORG_MIXED');
  const orgId = pinned ?? [...orgs][0] ?? null;
  let done = 0;
  const skipped: { id: string; code: string }[] = [];
  for (const pass of passes) {
    if (!pass) continue;
    if (mode !== null && pass.mode !== mode) {
      skipped.push({ id: pass.id, code: 'MODE_MISMATCH' });
      continue;
    }
    if (input.action === 'void') {
      if (pass.removedAt !== null) {
        skipped.push({ id: pass.id, code: 'PASS_REMOVED' });
        continue;
      }
      if (pass.status === 'active') await voidPass(ctx, actor, pass.id, scope);
      done++;
    } else if (input.action === 'remove') {
      await removePass(ctx, actor, pass.id, { message: input.message }, scope);
      done++;
    } else if (pass.removedAt !== null) {
      skipped.push({ id: pass.id, code: 'PASS_REMOVED' });
    } else if (!pass.holderEmail) {
      skipped.push({ id: pass.id, code: 'NO_RECIPIENT' });
    } else {
      await resendEmail(ctx, actor, pass.id, {}, scope);
      done++;
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
