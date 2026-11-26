import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import { OperationCancelled } from '../operations/progress-types.ts';
import { LEASE_MS } from '../operations/start.ts';
import { issueReplacement, tellOldPass } from './identity-move.ts';
import {
  adoptOpen,
  countMoves,
  deleteUnissued,
  getParams,
  insertMoves,
  type MoveParams,
  movesOf,
  setState,
} from './repo-identity-move.ts';
import { candidates } from './repo-identity-move-candidates.ts';

const PAGE = 100;
const ROWS = 20;
/** One invocation works this long, then hands the rest to a follow-up job: the queue's own limit is far off. */
const BUDGET_MS = 8 * 60_000;

/** Plans one row for every active Live pass on the old identity that has none. */
async function plan(ctx: ServiceContext, params: MoveParams, check: () => Promise<void>) {
  const db = ctx.env.DB;
  let after = '';
  for (;;) {
    await check();
    const page = await candidates(db, {
      orgId: params.org_id,
      identityId: params.from_identity_id,
      after,
      limit: PAGE,
    });
    const last = page[page.length - 1];
    if (!last) return;
    // A pass the move cannot copy faithfully stays as it is.
    await insertMoves(
      db,
      params,
      page.map((c) => {
        return {
          id: ctx.ids.id(),
          oldPassId: c.id,
          newPassId: ctx.ids.id(),
          state: c.reason ? ('kept' as const) : ('planned' as const),
          reason: c.reason,
        };
      }),
      ctx.clock.now(),
    );
    after = last.id;
  }
}

/**
 * Runs the operation: plan, issue the replacements (each emailed), tell the old passes. Every step is
 * "complete what is missing", so a resume after a crash, a stall resend or a retry repeats nothing: a row's
 * replacement id is fixed, and each state change is a guarded update.
 */
export async function runIdentityMove(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
  options: { budgetMs?: number } = {},
): Promise<void> {
  try {
    await runSteps(ctx, op, lease, options);
  } catch (error) {
    // A stopped run frees the passes it planned but never copied, so a later move to another identity sees them.
    if (error instanceof OperationCancelled) await deleteUnissued(ctx.env.DB, op.id);
    throw error;
  }
}

async function runSteps(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
  options: { budgetMs?: number },
): Promise<void> {
  const db = ctx.env.DB;
  const params = await getParams(db, op.id);
  if (!params)
    throw new AppError('IDENTITY_MOVE_PARAMS', 409, 'The move lost its settings. Start it again.');
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  const began = ctx.clock.now();
  const budget = options.budgetMs ?? BUDGET_MS;
  const over = () => ctx.clock.now() - began > budget;
  // The lease lapses first, so the follow-up job is the one that claims it. Not `sendOperationRun`: the
  // operations module imports this file's module for its runners, and that one imports the registry.
  const handOver = async (): Promise<void> => {
    await ctx.env.JOBS.send(
      { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
      { delaySeconds: LEASE_MS / 1000 + 1 },
    );
  };
  await adoptOpen(db, params, ctx.clock.now());
  const planning = progress.step('plan');
  await plan(ctx, params, () => progress.checkCancel());
  await planning.done();

  const issue = progress.step('issue');
  issue.total(await countMoves(db, op.id, 'planned'));
  let done = 0;
  for (let after = ''; ; ) {
    const rows = await movesOf(db, { opId: op.id, state: 'planned', after, limit: ROWS });
    const last = rows[rows.length - 1];
    if (!last) break;
    for (const row of rows) {
      await progress.checkCancel();
      if (over()) return handOver();
      try {
        await issueReplacement(ctx, row);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        ctx.log.warn('identity_move.issue_failed', { code: error.code, moveId: row.id });
        await setState(
          db,
          row.id,
          ['planned'],
          { state: 'failed', reason: error.code },
          ctx.clock.now(),
        );
      }
      await issue.count(++done);
    }
    after = last.id;
  }
  await issue.done();

  const notify = progress.step('notify');
  notify.total(await countMoves(db, op.id, 'issued'));
  done = 0;
  for (let after = ''; ; ) {
    const rows = await movesOf(db, { opId: op.id, state: 'issued', after, limit: ROWS });
    const last = rows[rows.length - 1];
    if (!last) break;
    for (const row of rows) {
      await progress.checkCancel();
      if (over()) return handOver();
      try {
        await tellOldPass(ctx, row);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // The row stays `issued`: the email went, and a retry tells the pass again.
        ctx.log.warn('identity_move.tell_failed', { code: error.code, moveId: row.id });
      }
      await notify.count(++done);
    }
    after = last.id;
  }
  await notify.done();

  const open =
    (await countMoves(db, op.id, 'planned')) +
    (await countMoves(db, op.id, 'issued')) +
    (await countMoves(db, op.id, 'failed'));
  if (open > 0)
    throw new AppError('IDENTITY_MOVE_PARTIAL', 502, 'Some passes were not moved. Retry.');
  await progress.succeed({ href: null, ids: { orgId: params.org_id } });
}
