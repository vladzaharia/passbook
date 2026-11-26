import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { unvoidedPassCount } from '../modules/developer/repo-sandbox-op.ts';
import { progressOf } from '../modules/operations/progress.ts';
import type { Progress } from '../modules/operations/progress-types.ts';
import {
  beginPurge,
  deletePassesPage,
  endState,
  finishPurge,
  leftovers,
  markVoided,
  passesLeft,
  phases,
  purgeFiles,
  purgeUploads,
  runRows,
  softDeletePage,
  stillPurging,
  voidPage,
} from '../modules/org-lifecycle/purge.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import { AppError } from '../platform/errors.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface OrgPurgeParams {
  orgId: string;
  /** The operation that reports this purge (a sandbox delete or start over): its `passes` count and `erase` wait. */
  operationId?: string;
  /** The operation's attempt: an old instance of a retried operation reports nothing. */
  attempt?: number;
  /** The purge ends the operation once the passes are voided. False when another runner does. */
  finish?: boolean;
}

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
const MAX_PAGES = 2000;
/** Wallet providers retire a pass in their own time: 28 waits of six hours before the run gives up. */
export const PROVIDER_ROUNDS = 28;

type StepLike = Pick<WorkflowStep, 'do' | 'sleep' | 'sleepUntil'>;
export type PurgeOutcome =
  | 'purged'
  | 'held'
  | 'not_due'
  | 'skipped'
  | 'done'
  | 'blocked'
  | 'incomplete';

/**
 * Removes a closed org. First every pass is voided and pushed, and devices get seven days to fetch it. Then
 * the passes (after Wallet providers let go), every row of the plan, its files, the receipt and the stub. A legal hold stops it at any step and leaves the rows that remain. Every step
 * is safe to repeat. Owner: org-lifecycle module.
 */
export async function runOrgPurge(
  env: AppEnv,
  params: OrgPurgeParams,
  step: StepLike,
  exec?: ExecutionContext,
  clock?: Clock,
  providerRounds = PROVIDER_ROUNDS,
): Promise<{ state: PurgeOutcome; deleted: number }> {
  const { orgId } = params;
  const ctx = createJobContext(env, 'org-purge', {
    ...(clock ? { clock } : {}),
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'org-purge', orgId },
  });
  const progress = progressOf(ctx, params.operationId, params.attempt ?? 1);
  try {
    const out = await purge(ctx, params, step, providerRounds, progress);
    // An operation that already ended ignores this: only a purge that stopped before the grace fails it.
    if (out.state !== 'purged' && out.state !== 'done')
      await progress.fail(
        new AppError(
          out.state === 'held' ? 'ORG_HELD' : 'ORG_PURGE_BLOCKED',
          409,
          'The purge did not finish.',
        ),
      );
    return out;
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}

async function purge(
  ctx: ReturnType<typeof createJobContext>,
  params: OrgPurgeParams,
  step: StepLike,
  providerRounds: number,
  progress: Progress,
): Promise<{ state: PurgeOutcome; deleted: number }> {
  const { orgId } = params;
  const started = await step.do('begin', () => beginPurge(ctx, orgId));
  if (started === 'held' || started === 'not_due' || started === 'skipped' || started === 'done')
    return { state: started, deleted: 0 };
  let deleted = 0;
  const alive = (name: string) => step.do(name, () => stillPurging(ctx, orgId));
  if (!(await alive('alive-void'))) return { state: 'held', deleted };
  let failed = 0;
  let from = '';
  const voiding = progress.step('passes');
  if (params.operationId)
    voiding.total(await step.do('count', () => unvoidedPassCount(ctx.env.DB, orgId)));
  let visited = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const at = from;
    const page = await step.do(`void-${i}`, RETRY, () => voidPage(ctx, orgId, at));
    failed += page.failed;
    visited += page.voided + page.failed;
    await voiding.count(visited);
    if (!page.more || !page.last) break;
    from = page.last;
  }
  if (failed > 0) {
    ctx.log.error('org.purge_void_blocked', { orgId, code: 'ORG_PURGE_VOID', passes: failed });
    return { state: 'blocked', deleted };
  }
  voiding.total(visited);
  await voiding.done();
  const graceEnds = await step.do('voided', () => markVoided(ctx, orgId));
  // The tail: the operation is done once the passes are voided; the erase waits out the devices' days.
  await progress.waiting('erase', { until: graceEnds, due: true });
  if (params.finish) await progress.succeed({ href: null, ids: { orgId } });
  // A start over goes on once the old passes are voided: its next run makes the new sandbox.
  else if (params.operationId)
    await step.do('continue', async () => {
      await ctx.env.JOBS.send({
        kind: 'operation.run',
        operationId: params.operationId as string,
        attempt: params.attempt ?? 1,
      });
      return true;
    });
  await step.sleepUntil('grace', new Date(graceEnds));
  if (!(await alive('alive-grace'))) return { state: 'held', deleted };
  await step.do('uploads', RETRY, () => purgeUploads(ctx, orgId));
  for (const phase of phases()) {
    if (phase.kind === 'rows') {
      if (!(await alive(`alive-${phase.name}`))) return { state: 'held', deleted };
      deleted += await step.do(`rows-${phase.name}`, RETRY, () => runRows(ctx, orgId, phase.steps));
      continue;
    }
    let after = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const cursor = after;
      const page = await step.do(`retire-${i}`, RETRY, () => softDeletePage(ctx, orgId, cursor));
      if (!page.more || !page.last) break;
      after = page.last;
    }
    let left = 1;
    for (let round = 0; round <= providerRounds && left > 0; round++) {
      let cursor = '';
      for (let i = 0; i < MAX_PAGES; i++) {
        const from = cursor;
        if (!(await alive(`alive-passes-${round}-${i}`))) return { state: 'held', deleted };
        const page = await step.do(`passes-${round}-${i}`, RETRY, () =>
          deletePassesPage(ctx, orgId, from),
        );
        deleted += page.deleted;
        if (!page.more || !page.last) break;
        cursor = page.last;
      }
      left = await step.do(`left-${round}`, () => passesLeft(ctx, orgId));
      if (left > 0 && round < providerRounds) await step.sleep(`wait-${round}`, '6 hours');
    }
    if (left > 0) {
      ctx.log.error('org.purge_blocked', { orgId, code: 'ORG_PURGE_BLOCKED', passes: left });
      return { state: 'blocked', deleted };
    }
  }
  if (!(await alive('alive-files'))) return { state: 'held', deleted };
  await step.do('files', RETRY, () => purgeFiles(ctx, orgId));
  const rest = await step.do('leftovers', () => leftovers(ctx, orgId));
  if (rest.length > 0) {
    ctx.log.error('org.purge_incomplete', { orgId, code: 'ORG_PURGE_INCOMPLETE', tables: rest });
    return { state: 'incomplete', deleted };
  }
  const total = deleted;
  const finished = await step.do('finish', () => finishPurge(ctx, orgId, total));
  if (finished) return { state: 'purged', deleted };
  // Another run claimed the stub, or a hold appeared at the last moment.
  return { state: await step.do('end-state', () => endState(ctx, orgId)), deleted };
}

export class OrgPurge extends WorkflowEntrypoint<AppEnv, OrgPurgeParams> {
  override async run(event: WorkflowEvent<OrgPurgeParams>, step: WorkflowStep): Promise<void> {
    await runOrgPurge(this.env, event.payload, step, this.ctx);
  }
}
