import type {
  CreatedDeveloperSandbox,
  DeveloperSandbox,
} from '../../../shared/contracts/developer.ts';
import { SANDBOX_TEMPLATE_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgDay } from '../org-lifecycle/org-day.ts';
import { quickstartTemplateOf, sandboxOfUser } from './repo.ts';
import { deletesSince } from './repo-grants-delete.ts';
import { DELETES_PER_DAY, deleteSandbox } from './repo-grants-reset.ts';
import { createSandbox, dto } from './service.ts';

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

/**
 * Deletes the caller's sandbox, open or closed. The org closes with its purge due now, and the org purge (the
 * one org deletion uses) voids and pushes its passes and removes every row. The person's record goes with it, so
 * they can make a new one. If starting the purge fails, the daily sweep finds the org: it is due. Answers with the
 * sandbox as it was, closed.
 */
export async function deleteOwnSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<DeveloperSandbox> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  const now = ctx.clock.now();
  const recent = await deletesSince(ctx.env.DB, session.userId, now - DAY_MS);
  if (recent.length >= DELETES_PER_DAY) throw limited(recent, now);
  await deleteSandbox(
    ctx,
    { id: row.id, orgId: row.org_id },
    { userId: session.userId, sessionIdHash: session.sessionId },
  );
  ctx.log.info('developer.sandbox_deleted', { orgId: row.org_id });
  const templateId = await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME);
  const gone = dto({ ...row, closed_at: row.closed_at ?? now }, templateId);
  try {
    await ctx.env.ORG_PURGE?.create({
      id: `org-purge-${row.org_id}-${await orgDay(ctx, row.org_id, now)}`,
      params: { orgId: row.org_id },
    });
  } catch (error) {
    ctx.log.warn('developer.sandbox_purge_deferred', {
      orgId: row.org_id,
      code: 'ORG_PURGE_START',
      error,
    });
  }
  return gone;
}

/** Delete, then make a new sandbox: a new org and slug, and a new key shown once. */
export async function recreateSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
  options: { viewedAt?: number } = {},
): Promise<CreatedDeveloperSandbox> {
  if (await sandboxOfUser(ctx.env.DB, session.userId)) await deleteOwnSandbox(ctx, session);
  return createSandbox(ctx, session, {}, options);
}
