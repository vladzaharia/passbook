import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import { failStarted, tryStartOrgOperation } from '../operations/start-org.ts';
import type { TenantPassWrite } from '../passes/http.ts';

/**
 * One operation for a bulk "turn off and replace codes": the channels step is already done, and each pass's job
 * counts the second one as it finishes. Returns the operation id, or null when no code is to be replaced.
 */
export async function queueCodeReplacements(
  ctx: ServiceContext,
  authority: Pick<TenantPassWrite, 'orgId' | 'mode'>,
  starter: { type: 'user' | 'api_key' | 'system'; id: string | null } | undefined,
  x: { passIds: string[]; key: string; updated: number },
): Promise<string | null> {
  if (x.passIds.length === 0) return null;
  const op = await tryStartOrgOperation(ctx, starter ?? { type: 'system', id: null }, {
    kind: 'channels.replace_codes',
    orgId: authority.orgId,
    mode: authority.mode,
    target: { type: 'org', id: authority.orgId },
  });
  if (op) {
    const progress = progressOf(ctx, op.id, op.attempt);
    const channels = progress.step('channels');
    channels.total(x.updated);
    await channels.count(x.updated);
    await channels.done();
    const codes = progress.step('codes');
    codes.total(x.passIds.length);
    await codes.count(0);
  }
  try {
    for (const passId of x.passIds)
      await ctx.env.JOBS.send({
        kind: 'channel.replace_code',
        passId,
        key: x.key,
        ...(op ? { operationId: op.id, attempt: op.attempt } : {}),
      });
  } catch (error) {
    if (op) await failStarted(ctx, op, error);
    throw error;
  }
  return op?.id ?? null;
}
