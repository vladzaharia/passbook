import type { CreatedDeveloperSandbox } from '../../../shared/contracts/developer.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { SANDBOX_TEMPLATE_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Progress } from '../operations/progress-types.ts';
import { endCliTokensOf } from '../workbench/cli-revoke.ts';
import { quickstartTemplateOf, type SandboxRow, sandboxOfUser } from './repo.ts';
import {
  deleteCaptures,
  RESET_ACTION,
  RESETS_PER_DAY,
  reopenSandbox,
  restartTrack,
} from './repo-grants-reset.ts';
import {
  closeReasonOf,
  orgHeld,
  reopenWindow,
  resetsClaimedSince,
  trackStartRaw,
} from './repo-reset.ts';
import { captureTotal, resetPassTotal } from './repo-sandbox-op.ts';
import { emptyTally, purgePasses, purgeRows, ROW_TABLES } from './reset-purge.ts';
import { dto, mintSandboxKey, quickstartTemplate } from './service.ts';

const DAY_MS = 86_400_000;

const resetsUsed = (ctx: ServiceContext, orgId: string): Promise<number> =>
  resetsClaimedSince(ctx.env.DB, orgId, RESET_ACTION, ctx.clock.now() - DAY_MS);

const limited = () =>
  new AppError(
    'SANDBOX_RESET_LIMIT',
    429,
    `You can reset a sandbox ${RESETS_PER_DAY} times a day. Try again tomorrow.`,
    { headers: { 'retry-after': '3600' } },
  );

/** What a reset needs before it starts: an open sandbox, no legal hold, a slot left today. */
export async function checkReset(ctx: ServiceContext, session: SessionAuth): Promise<SandboxRow> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at !== null)
    throw new ConflictError('The sandbox is closed. Reopen it first.', 'SANDBOX_CLOSED');
  if (await orgHeld(ctx.env.DB, row.org_id))
    throw new ConflictError('A legal hold stands on this sandbox.', 'ORG_HELD');
  if ((await resetsUsed(ctx, row.org_id)) >= RESETS_PER_DAY) throw limited();
  return row;
}

/**
 * Resets the caller's own sandbox: the quickstart track starts again, its test passes, captured webhooks, request
 * log, bundles, imports, broadcasts, rules and idempotency records are deleted, and the ticket template is
 * released again. Kept: the org, capture endpoint, membership, other keys and the funnel's first values. The org
 * is always the caller's own sandbox, never a request value. The new key is minted afterwards (`sandbox-key.ts`).
 *
 * The claim spends one of 3 daily slots, restarts the track and revokes the old key in one batch. A retry finds
 * the claim step done and resumes under the same stamp without spending a slot. The purge has no time budget:
 * it runs as long as it needs, and its steps carry the counts.
 */
export async function resetSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
  op: Pick<OperationDto, 'steps' | 'target'>,
  progress: Progress,
  after: (step: string) => Promise<void> = async () => undefined,
): Promise<{ sandbox: ReturnType<typeof dto>; ids: Record<string, string> }> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at !== null)
    throw new ConflictError('The sandbox is closed. Reopen it first.', 'SANDBOX_CLOSED');
  // The operation was about one sandbox; a newer one the person made since is not ours to wipe.
  if (op.target && op.target.id !== row.org_id)
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  const orgId = row.org_id;
  const sandbox = { id: row.id, orgId };
  if (await orgHeld(ctx.env.DB, orgId))
    throw new ConflictError('A legal hold stands on this sandbox.', 'ORG_HELD');
  const earlier = new Map(op.steps.map((s) => [s.key, s]));
  const prev = await trackStartRaw(ctx.env.DB, orgId);
  const claim = progress.step('claim');
  let stamp: number;
  let used = await resetsUsed(ctx, orgId);
  if (earlier.get('claim')?.state === 'done' && prev !== null) {
    stamp = prev;
  } else {
    if (used >= RESETS_PER_DAY) throw limited();
    stamp = Math.max(ctx.clock.now(), (prev ?? row.created_at) + 1);
    try {
      await restartTrack(
        ctx,
        sandbox,
        { userId: session.userId, sessionIdHash: session.sessionId },
        stamp,
        prev,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SANDBOX_CONFLICT') throw error;
      // A refused check: the last slot went to a racing reset, or the sandbox changed under us.
      if ((await resetsUsed(ctx, orgId)) >= RESETS_PER_DAY) throw limited();
      throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
    }
    used += 1;
  }
  // A reset ends the CLI tokens of the sandbox: the person signs in again.
  await endCliTokensOf(ctx, { orgId }, 'sandbox_reset');
  await claim.done();
  await after('claim');

  const tally = emptyTally();
  const passes = progress.step('passes');
  const base = earlier.get('passes')?.done ?? 0;
  passes.total(base + (await resetPassTotal(ctx.env.DB, orgId)));
  if (!(await purgePasses(ctx, sandbox, session.userId, stamp, tally, passes, base)))
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  passes.total(base + tally.passes);
  await passes.done();
  await after('passes');

  const captures = progress.step('captures');
  captures.total(await captureTotal(ctx.env.DB, orgId, stamp));
  tally.captures = await deleteCaptures(ctx, sandbox, session.userId, stamp);
  captures.total(tally.captures);
  await captures.count(tally.captures);
  await captures.done();
  await after('captures');

  const rows = progress.step('rows');
  rows.total(ROW_TABLES);
  await purgeRows(ctx, orgId, session.userId, stamp, tally, rows);
  await rows.done();
  await after('rows');
  ctx.log.info('developer.sandbox_reset', {
    orgId,
    deleted: {
      passes: tally.passes,
      captures: tally.captures,
      calls: tally.calls,
      other: tally.other,
    },
    kept: tally.kept,
  });

  const template = progress.step('template');
  const templateId = await quickstartTemplate(ctx, { ...session, mode: 'test' }, orgId);
  await template.done();
  return {
    sandbox: dto(row, templateId),
    ids: {
      orgId,
      passes: String(tally.passes),
      captures: String(tally.captures),
      calls: String(tally.calls),
      other: String(tally.other),
      kept: String(tally.kept),
      resetsLeft: String(Math.max(0, RESETS_PER_DAY - used)),
    },
  };
}

/**
 * Reopens the caller's own closed sandbox inside its 30 days, then makes a new key (closing revoked the old
 * ones). An administrator's close stays closed: only a close by the person or the idle sweep reopens here.
 */
export async function reopenOwnSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<CreatedDeveloperSandbox> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at === null)
    throw new ConflictError('The sandbox is already open.', 'SANDBOX_NOT_CLOSED');
  const org = await reopenWindow(ctx.env.DB, row.org_id);
  if (!org || org.purge_started_at !== null || (org.purge_after ?? 0) < ctx.clock.now())
    throw new ConflictError('The reopen window has passed.', 'SANDBOX_REOPEN_WINDOW');
  try {
    await reopenSandbox(
      ctx,
      { id: row.id, orgId: row.org_id },
      {
        userId: session.userId,
        sessionIdHash: session.sessionId,
      },
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SANDBOX_CONFLICT') throw error;
    // The in-write checks refused: an administrator's close (the person cannot undo it), else a race.
    if ((await closeReasonOf(ctx.env.DB, row.org_id)) === 'admin')
      throw new ConflictError(
        'An administrator closed this sandbox. Ask an administrator.',
        'SANDBOX_REOPEN_ADMIN',
      );
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  }
  const after = await sandboxOfUser(ctx.env.DB, session.userId);
  const test: SessionAuth = { ...session, mode: 'test' };
  const key = await mintSandboxKey(ctx, test, row.org_id);
  return {
    ...dto(after ?? row, await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME)),
    key,
    previousKey: null,
  };
}
