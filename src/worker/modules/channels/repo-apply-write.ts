import type { Channel } from '../../../shared/contracts/channels.ts';
import { jobGrant } from '../../platform/authority.ts';
import { exists, notExists } from '../../platform/authority-cond.ts';
import { inList } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Policy } from './repo.ts';
import type { ApplyEvent, PagePass } from './repo-apply.ts';
import type { ApplyCounts, ApplyRun } from './repo-runs.ts';

const JOB = 'channel-apply';
const ACTOR = { type: 'system', id: JOB } as const;
export const APPLY_BY = JOB;

/** A job grant for one run: its org and mode, only the tables the step writes. */
function runGrant(ctx: ServiceContext, run: ApplyRun, step: string, tables: string[], extra = {}) {
  return jobGrant(ctx, {
    purpose: `org_mode.job.channels.${step}`,
    job: JOB,
    orgId: run.orgId,
    mode: run.mode,
    target: run.id,
    tables,
    ...extra,
  });
}

function audit(
  ctx: ServiceContext,
  run: ApplyRun,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown>,
) {
  return {
    at: ctx.clock.now(),
    orgId: run.orgId,
    actorType: ACTOR.type,
    actorId: ACTOR.id,
    action,
    targetType,
    targetId,
    requestId: null,
    ipPrefix: null,
    detail: JSON.stringify(detail),
  };
}

/** pending to running with the policy as it is now. False when another run of the template is running or a save moved the policy. */
export async function writeStart(
  ctx: ServiceContext,
  run: ApplyRun,
  to: Policy,
  revision: number,
): Promise<boolean> {
  const g = runGrant(ctx, run, 'start', ['channel_apply_runs']);
  const now = ctx.clock.now();
  const started = g.update('channel_apply_runs', {
    set: {
      state: 'running',
      to_channels: JSON.stringify(to),
      to_revision: revision,
      started_at: now,
      updated_at: now,
    },
    where: { id: run.id, state: 'pending' },
    returning: ['id'],
    when: [
      notExists('channel_apply_runs', { template_id: run.templateId, state: 'running' }),
      revision === 0
        ? notExists('template_channel_policies', { template_id: run.templateId })
        : exists('template_channel_policies', { template_id: run.templateId, revision }),
    ],
  });
  const results = await g.commit();
  return (results[g.indexOf(started)]?.results?.length ?? 0) === 1;
}

/** pending to dropped: the policy is back where the run began, so there is nothing to apply. */
export async function writeDrop(ctx: ServiceContext, run: ApplyRun): Promise<void> {
  const g = runGrant(ctx, run, 'drop', ['channel_apply_runs']);
  const now = ctx.clock.now();
  g.update('channel_apply_runs', {
    set: { state: 'dropped', finished_at: now, updated_at: now },
    where: { id: run.id, state: 'pending' },
  });
  await g.commit();
}

/** running to done with the totals, audited once. */
export async function writeFinish(
  ctx: ServiceContext,
  run: ApplyRun,
  counts: ApplyCounts,
): Promise<void> {
  const g = runGrant(ctx, run, 'finish', ['channel_apply_runs']);
  const now = ctx.clock.now();
  g.update('channel_apply_runs', {
    set: { state: 'done', counts: JSON.stringify(counts), finished_at: now, updated_at: now },
    where: { id: run.id, state: 'running' },
  });
  g.audit(
    audit(ctx, run, 'template.channels_apply', 'template', run.templateId, {
      runId: run.id,
      mode: run.mode,
      counts,
      errorCode: run.errorCode,
    }),
    [exists('channel_apply_runs', { id: run.id, state: 'done', finished_at: now })],
  );
  await g.commit();
}

/** pending or running to failed. Allowed while the org is suspended: the run must still end. */
export async function writeFail(ctx: ServiceContext, run: ApplyRun, code: string): Promise<void> {
  const g = runGrant(ctx, run, 'fail', ['channel_apply_runs'], { inactiveOk: true });
  const now = ctx.clock.now();
  g.update('channel_apply_runs', {
    set: { state: 'failed', error_code: code, finished_at: now, updated_at: now },
    where: { id: run.id, state: inList(['pending', 'running']) },
  });
  await g.commit();
}

/** The cursor and totals after a page, so the next page starts past it. */
export async function writeCursor(
  ctx: ServiceContext,
  run: ApplyRun,
  cursor: string,
  counts: ApplyCounts,
): Promise<void> {
  const g = runGrant(ctx, run, 'cursor', ['channel_apply_runs']);
  g.update('channel_apply_runs', {
    set: { cursor, counts: JSON.stringify(counts), updated_at: ctx.clock.now() },
    where: { id: run.id, state: 'running' },
    require: 'one',
  });
  await g.commit();
}

/** Marks whose events went to the journal. */
export async function writeJournaled(ctx: ServiceContext, run: ApplyRun): Promise<void> {
  const g = runGrant(ctx, run, 'journal', ['channel_apply_marks']);
  g.joined('channel_apply_marks', {
    where: { run_id: run.id, journaled_at: null },
    set: { journaled_at: ctx.clock.now() },
  });
  await g.commit();
}

export interface PassApply {
  pass: PagePass;
  rows: {
    channel: Channel;
    retiredAt: number | null;
    retiredCause: 'pass' | 'template' | null;
  }[];
  /** Row revisions as read: a row moved since is refused (CHANNEL_APPLY_STALE). */
  revisions: Partial<Record<Channel, number>>;
  events: ApplyEvent[];
  voidPrints: boolean;
  /** The run's totals with this pass included. */
  counts: ApplyCounts;
}

/** One pass's markers, audits, void, mark and the run's totals, in one commit. */
export async function writePassApply(
  ctx: ServiceContext,
  run: ApplyRun,
  w: PassApply,
): Promise<void> {
  const g = runGrant(
    ctx,
    run,
    'apply',
    ['pass_channels', 'pass_prints', 'channel_apply_marks', 'channel_apply_runs'],
    { codes: { stale: 'CHANNEL_APPLY_STALE' } },
  );
  const now = ctx.clock.now();
  const { pass } = w;
  for (const r of w.rows) {
    const seen = w.revisions[r.channel];
    g.assert('stale', [
      seen === undefined
        ? notExists('pass_channels', { pass_id: pass.id, channel: r.channel })
        : exists('pass_channels', { pass_id: pass.id, channel: r.channel, revision: seen }),
    ]);
    g.upsert(
      'pass_channels',
      [
        'pass_id',
        'template_id',
        'channel',
        'override',
        'retired_at',
        'retired_cause',
        'set_by',
        'set_at',
      ],
      [pass.id, pass.templateId, r.channel, null, r.retiredAt, r.retiredCause, APPLY_BY, now],
      { update: ['retired_at', 'retired_cause', 'set_by', 'set_at'], inc: ['revision'] },
    );
  }
  for (const e of w.events)
    g.audit(audit(ctx, run, 'pass.channels_change', 'pass', pass.id, { ...e }));
  if (w.voidPrints) {
    g.update('pass_prints', {
      set: { status: 'voided', voided_at: now, void_cause: 'channel_off' },
      where: { pass_id: pass.id, status: 'active' },
    });
    g.audit(
      audit(ctx, run, 'pass.print_void', 'pass', pass.id, { printId: null, cause: 'channel_off' }),
      [
        exists('pass_prints', {
          pass_id: pass.id,
          status: 'voided',
          void_cause: 'channel_off',
          voided_at: now,
        }),
      ],
    );
  }
  g.insertJoined('channel_apply_marks', {
    parents: { run_id: run.id },
    columns: ['pass_id', 'events'],
    values: [pass.id, JSON.stringify(w.events)],
  });
  g.update('channel_apply_runs', {
    set: { counts: JSON.stringify(w.counts), updated_at: now },
    where: { id: run.id, state: 'running' },
    require: 'one',
  });
  await g.commit();
}
