import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  beginPurge,
  deletePassesPage,
  finishPurge,
  leftovers,
  passesLeft,
  phases,
  purgeFiles,
  runRows,
  stillPurging,
  voidPage,
} from '../modules/org-lifecycle/purge.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface OrgPurgeParams {
  orgId: string;
}

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
const MAX_PAGES = 2000;
/** Wallet providers retire a pass in their own time: 28 waits of six hours before the run gives up. */
export const PROVIDER_ROUNDS = 28;

type StepLike = Pick<WorkflowStep, 'do' | 'sleep'>;
export type PurgeOutcome =
  | 'purged'
  | 'held'
  | 'not_due'
  | 'skipped'
  | 'done'
  | 'blocked'
  | 'incomplete';

/**
 * Removes a closed org: its passes (after Wallet providers let go), every row of the plan, its files, then
 * the receipt and the stub. A legal hold stops it at any step and leaves the rows that remain. Every step
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
  const started = await step.do('begin', () => beginPurge(ctx, orgId));
  if (started === 'held' || started === 'not_due' || started === 'skipped' || started === 'done')
    return { state: started, deleted: 0 };
  let deleted = 0;
  const alive = (name: string) => step.do(name, () => stillPurging(ctx, orgId));
  for (const phase of phases()) {
    if (phase.kind === 'rows') {
      if (!(await alive(`alive-${phase.name}`))) return { state: 'held', deleted };
      deleted += await step.do(`rows-${phase.name}`, RETRY, () => runRows(ctx, orgId, phase.steps));
      continue;
    }
    let after = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const from = after;
      const page = await step.do(`void-${i}`, RETRY, () => voidPage(ctx, orgId, from));
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
  return { state: finished ? 'purged' : 'held', deleted };
}

export class OrgPurge extends WorkflowEntrypoint<AppEnv, OrgPurgeParams> {
  override async run(event: WorkflowEvent<OrgPurgeParams>, step: WorkflowStep): Promise<void> {
    await runOrgPurge(this.env, event.payload, step, this.ctx);
  }
}
