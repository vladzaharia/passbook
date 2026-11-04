import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { removePass } from './remove.ts';
import { getPass } from './repo.ts';
import { type Actor, resendEmail, voidPass } from './service.ts';

export interface BulkPassAction {
  action: 'void' | 'send_email' | 'remove';
  message?: string | undefined;
  ids: string[];
  orgId?: string;
}

/**
 * Applies one action to up to 100 passes, each audited as its own action. Every id must exist in
 * the caller's org (the key's scope or the admin's `orgId`); otherwise nothing runs.
 */
export async function bulkPassAction(
  ctx: ServiceContext,
  actor: Actor,
  input: BulkPassAction,
  scope: string | null,
): Promise<{ done: number; skipped: { id: string; code: string }[] }> {
  const orgId = scope ?? input.orgId ?? null;
  const ids = [...new Set(input.ids)];
  const passes = await Promise.all(ids.map((id) => getPass(ctx.env.DB, id, orgId)));
  if (passes.some((p) => p === null))
    throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
  let done = 0;
  const skipped: { id: string; code: string }[] = [];
  for (const pass of passes) {
    if (!pass) continue;
    if (input.action === 'void') {
      if (pass.removedAt !== null) {
        skipped.push({ id: pass.id, code: 'PASS_REMOVED' });
        continue;
      }
      if (pass.status === 'active') await voidPass(ctx, actor, pass.id, orgId);
      done++;
    } else if (input.action === 'remove') {
      await removePass(ctx, actor, pass.id, { message: input.message }, orgId);
      done++;
    } else if (!pass.holderEmail) {
      skipped.push({ id: pass.id, code: 'NO_RECIPIENT' });
    } else {
      await resendEmail(ctx, actor, pass.id, {}, orgId);
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
