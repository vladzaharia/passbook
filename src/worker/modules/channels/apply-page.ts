import { channelTransition, effectiveChannels } from '../../../shared/channels.ts';
import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { type Cost, msToNextMinute, PageBudget, spend } from './apply-budget.ts';
import { isOrgRefusal, ORG_INACTIVE } from './apply-run.ts';
import {
  type ApplyEvent,
  channelRevisions,
  marksOf,
  PAGE_SIZE,
  type PagePass,
  passPage,
  unjournaled,
} from './repo-apply.ts';
import { type PassApply, writeCursor, writeJournaled, writePassApply } from './repo-apply-write.ts';
import { type ApplyCounts, type ApplyRun, getRun } from './repo-runs.ts';
import { type LoadedPass, loadMany } from './service.ts';

export interface PageResult {
  done: boolean;
  /** Milliseconds to rest before the next page. */
  wait?: number;
  /** The run cannot go on: the code it ends with. */
  failed?: string;
}

const REST_AFTER_WORK = 60_000;
const REST_IDLE = 1_000;
const ACTOR = { type: 'system', id: 'channel-apply' } as const;

interface Plan {
  write: Omit<PassApply, 'pass' | 'revisions' | 'counts'> | null;
  cost: Cost;
  appleChanged: boolean;
}

/** What the run's policy change does to one pass, from the pass's live inputs. */
function plan(run: ApplyRun, loaded: LoadedPass, now: number): Plan {
  const { inputs, rows } = loaded;
  const before = effectiveChannels({ ...inputs, template: run.from });
  const after = effectiveChannels({ ...inputs, template: run.to });
  const actions = channelTransition(before, after, {
    copies: new Set(rows.copies),
    retired: new Set(Object.keys(rows.retired) as Channel[]),
  });
  const events: ApplyEvent[] = CHANNELS.filter((c) => before[c].on !== after[c].on).map(
    (channel) => ({
      channel,
      from: before[channel].on ? 'on' : 'off',
      to: after[channel].on ? 'on' : 'off',
      source: after[channel].source,
      runId: run.id,
    }),
  );
  const marks: NonNullable<Plan['write']>['rows'] = [];
  const cost: Cost = {};
  const add = (p: keyof Cost) => {
    cost[p] = (cost[p] ?? 0) + 1;
  };
  let appleChanged = false;
  for (const a of actions) {
    if (a.kind === 'retire') {
      const source = after[a.channel].source;
      marks.push({
        channel: a.channel,
        retiredAt: now,
        retiredCause: source === 'pass' || source === 'template' ? source : null,
      });
      if (a.channel === 'google' || a.channel === 'samsung') add(a.channel);
    } else if (a.kind === 'restore') {
      marks.push({ channel: a.channel, retiredAt: null, retiredCause: null });
    } else continue;
    if (a.channel === 'apple') {
      add('apple');
      appleChanged = true;
    }
  }
  // The Apple republish also refreshes an active Google object (N4).
  if (appleChanged && rows.copies.includes('google') && after.google.on) add('google');
  const voidPrints = actions.some((a) => a.kind === 'void_prints');
  const empty = events.length === 0 && marks.length === 0 && !voidPrints;
  return { write: empty ? null : { rows: marks, events, voidPrints }, cost, appleChanged };
}

/** Events of marks written but not yet journaled (a crash, or the pass's own page). */
async function journal(ctx: ServiceContext, run: ApplyRun): Promise<void> {
  const pending = await unjournaled(ctx.env.DB, run.id);
  if (pending.length === 0) return;
  await recordPassEvents(
    ctx,
    pending.flatMap((m) =>
      m.events.map((data) => ({
        orgId: run.orgId,
        passId: m.passId,
        mode: run.mode,
        kind: 'pass.channels_changed' as const,
        actor: ACTOR,
        data,
      })),
    ),
  );
  await writeJournaled(ctx, run);
}

/** Queues the republish that carries an Apple flip; the job skips when a publish got there first. */
async function queueAppleBump(ctx: ServiceContext, passId: string): Promise<void> {
  const current = await getPass(ctx.env.DB, passId);
  if (!current) return;
  await ctx.env.JOBS.send({ kind: 'channel.apple_bump', passId, version: current.version });
}

/** A pass this run already marked (a retried page): only the republish a lost message left. */
async function finishMarked(
  ctx: ServiceContext,
  pass: PagePass,
  loaded: LoadedPass | undefined,
  events: ApplyEvent[],
): Promise<void> {
  if (!events.some((e) => e.channel === 'apple')) return;
  const current = await getPass(ctx.env.DB, pass.id);
  if (current && (loaded?.rows.setAt.apple ?? 0) > current.modifiedAt)
    await ctx.env.JOBS.send({
      kind: 'channel.apple_bump',
      passId: pass.id,
      version: current.version,
    });
}

async function page(ctx: ServiceContext, run: ApplyRun): Promise<PageResult> {
  const db = ctx.env.DB;
  await journal(ctx, run);
  const passes = await passPage(db, run);
  if (passes.length === 0) return { done: true };
  const ids = passes.map((p) => p.id);
  const [loaded, marks, revisions, budget] = await Promise.all([
    loadMany(ctx, passes),
    marksOf(db, run.id, ids),
    channelRevisions(db, ids),
    PageBudget.open(db, ctx.clock.now()),
  ]);
  let counts: ApplyCounts = { ...run.counts };
  let cursor: string | null = null;
  let wait: number | undefined;
  let stopped = false;
  let spent = false;

  for (const pass of passes) {
    const marked = marks.get(pass.id);
    if (marked) {
      await finishMarked(ctx, pass, loaded.get(pass.id), marked);
      cursor = pass.id;
      continue;
    }
    let state = loaded.get(pass.id);
    let seen = revisions.get(pass.id) ?? {};
    let done = false;
    for (let attempt = 0; attempt < 2 && !done && state; attempt++) {
      const p = plan(run, state, ctx.clock.now());
      if (!p.write) {
        done = true;
        break;
      }
      const blocked = budget.blocked(p.cost);
      if (blocked) {
        stopped = true;
        if (blocked === 'minute') wait = msToNextMinute(ctx.clock.now());
        break;
      }
      const next: ApplyCounts = {
        ...counts,
        changed: counts.changed + 1,
        flips: counts.flips + p.write.events.length,
      };
      try {
        await writePassApply(ctx, run, { pass, revisions: seen, counts: next, ...p.write });
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CHANNEL_APPLY_STALE') throw error;
        // A pass-level write moved a row since the read: recompute once from the live rows.
        state = (await loadMany(ctx, [pass])).get(pass.id);
        seen = (await channelRevisions(db, [pass.id])).get(pass.id) ?? {};
        continue;
      }
      counts = next;
      budget.take(p.cost);
      spent = true;
      await spend(db, ctx.clock.now(), p.cost);
      if (p.appleChanged) await queueAppleBump(ctx, pass.id);
      done = true;
    }
    if (stopped) break;
    if (!done) counts = { ...counts, stale: counts.stale + 1 };
    cursor = pass.id;
  }

  await journal(ctx, run);
  if (cursor) await writeCursor(ctx, run, cursor, counts);
  if (!stopped && passes.length < PAGE_SIZE) return { done: true };
  return { done: false, wait: wait ?? (spent ? REST_AFTER_WORK : REST_IDLE) };
}

/** One page of the run, at most 100 passes. A refusal of the org ends the run as inactive. */
export async function applyChannelPage(ctx: ServiceContext, runId: string): Promise<PageResult> {
  const run = await getRun(ctx.env.DB, runId);
  if (run?.state !== 'running' || !run.to) return { done: true };
  try {
    return await page(ctx, run);
  } catch (error) {
    if (isOrgRefusal(error)) return { done: true, failed: ORG_INACTIVE };
    throw error;
  }
}
