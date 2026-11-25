import type { CreatedDeveloperSandbox } from '../../../shared/contracts/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sandboxOfUser } from './repo.ts';
import { DELETES_PER_DAY, deleteSandbox, deletesSince } from './repo-grants-delete.ts';
import { createSandbox } from './service.ts';

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Three a day: the wait is until the oldest of them leaves the window. */
function limited(times: number[], now: number): AppError {
  const oldest = times.at(-1) ?? now;
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
 * they can make a new one. If starting the purge fails, the daily sweep finds the org: it is due.
 */
export async function deleteOwnSandbox(ctx: ServiceContext, session: SessionAuth): Promise<void> {
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
  try {
    await ctx.env.ORG_PURGE?.create({
      id: `org-purge-${row.org_id}-${day(now)}`,
      params: { orgId: row.org_id },
    });
  } catch (error) {
    ctx.log.warn('developer.sandbox_purge_deferred', {
      orgId: row.org_id,
      code: 'ORG_PURGE_START',
      error,
    });
  }
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
