import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { OrgPurgeParams } from '../../workflows/org-purge.ts';
import type { Progress } from '../operations/progress-types.ts';
import { orgDay } from '../org-lifecycle/org-day.ts';
import { type SandboxRow, sandboxOfUser } from './repo.ts';
import { deletesSince } from './repo-grants-delete.ts';
import { DELETES_PER_DAY, deleteSandbox } from './repo-grants-reset.ts';
import { liveKeyCount } from './repo-sandbox-op.ts';

const DAY_MS = 86_400_000;

/** Three a day: the wait is until enough of them leave the window. */
function limited(times: number[], now: number): AppError {
  // The slot that frees first is the one that, once it ages out, leaves fewer than three on record.
  const oldest = times[times.length - DELETES_PER_DAY] ?? now;
  const wait = Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000));
  return new AppError(
    'SANDBOX_RESET_LIMIT',
    429,
    `You can delete a sandbox ${DELETES_PER_DAY} times a day. Try again later.`,
    { headers: { 'retry-after': String(wait) } },
  );
}

/** What a delete needs before it starts: a sandbox, open or closed, and a slot left today. */
export async function checkDelete(ctx: ServiceContext, session: SessionAuth): Promise<SandboxRow> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  const now = ctx.clock.now();
  const recent = await deletesSince(ctx.env.DB, session.userId, now - DAY_MS);
  if (recent.length >= DELETES_PER_DAY) throw limited(recent, now);
  return row;
}

/**
 * Closes the person's sandbox, open or closed, and revokes its keys, in one batch: the org closes with its purge
 * due now, and the person's record goes, so they can make a new one. Reported as `close` and `keys`. A sandbox
 * already gone (an earlier attempt did this) is a no-op. Null, or the org the purge takes from here.
 */
export async function deleteHalf(
  ctx: ServiceContext,
  by: { userId: string; sessionIdHash: string },
  progress: Progress,
): Promise<string | null> {
  const row = await sandboxOfUser(ctx.env.DB, by.userId);
  if (!row) return null;
  const close = progress.step('close');
  const keyCount = await liveKeyCount(ctx.env.DB, row.org_id);
  await deleteSandbox(ctx, { id: row.id, orgId: row.org_id }, by);
  ctx.log.info('developer.sandbox_deleted', { orgId: row.org_id });
  await close.done();
  const keys = progress.step('keys');
  keys.total(keyCount);
  await keys.count(keyCount);
  await keys.done();
  return row.org_id;
}

/**
 * The org purge instance of an attempt. The first uses the day's name, so the daily sweep that finds the org due
 * cannot start a second; a retry names its own (`<opId>-r<attempt>`).
 */
export async function purgeInstanceId(
  ctx: ServiceContext,
  op: Pick<OperationDto, 'id' | 'attempt'>,
  orgId: string,
  now: number,
): Promise<string> {
  return op.attempt === 1
    ? `org-purge-${orgId}-${await orgDay(ctx, orgId, now)}`
    : `${op.id}-r${op.attempt}`;
}

/**
 * Starts the org purge for the operation: it reports `passes` and the `erase` wait, and with `finish` it also
 * ends the operation. A runner that holds a lease passes its token, so the purge's writes are the runner's own. False when this Worker has no purge Workflow (a test, a script): the caller skips the step.
 * A start that fails is thrown: the operation stops on `passes` and Retry starts it again.
 */
export async function startPurge(
  ctx: ServiceContext,
  op: Pick<OperationDto, 'id' | 'attempt'>,
  orgId: string,
  instanceId: string,
  finish: boolean,
  lease?: string,
): Promise<boolean> {
  const binding = ctx.env.ORG_PURGE;
  if (!binding) return false;
  const params: OrgPurgeParams = {
    orgId,
    operationId: op.id,
    attempt: op.attempt,
    finish,
    ...(lease ? { lease } : {}),
  };
  try {
    await binding.create({ id: instanceId, params });
  } catch (error) {
    // The same instance already runs (a resumed run, or the day's sweep): it is the purge.
    const running =
      typeof binding.get === 'function' ? await binding.get(instanceId).catch(() => null) : null;
    if (running) return true;
    ctx.log.warn('developer.sandbox_purge_deferred', { orgId, code: 'ORG_PURGE_START', error });
    throw new AppError('SANDBOX_PURGE_START', 500, 'The cleanup did not start.');
  }
  return true;
}
