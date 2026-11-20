import { channelTransition, effectiveChannels } from '../../../shared/channels.ts';
import { CHANNELS, type Channel } from '../../../shared/contracts/channels.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { type Cost, msToNextMinute, PageBudget, spend } from './apply-budget.ts';
import { journal } from './apply-journal.ts';
import { effectiveFrom, isOrgRefusal, ORG_INACTIVE } from './apply-run.ts';
import { noticeHolder, rotateCode } from './replace.ts';
import {
  type ApplyEvent,
  channelRevisions,
  marksOf,
  PAGE_SIZE,
  type PagePass,
  passPage,
} from './repo-apply.ts';
import { type PassApply, writeCursor, writeNotice, writePassApply } from './repo-apply-write.ts';
import { unnoticed } from './repo-replace.ts';
import { type ApplyCounts, type ApplyRun, getRun, rotating } from './repo-runs.ts';
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
/** Passes per page of a run that replaces codes. */
export const REPLACE_PAGE_SIZE = 5;

interface Plan {
  write: Omit<PassApply, 'pass' | 'revisions' | 'counts'> | null;
  cost: Cost;
  appleChanged: boolean;
  /** The pass owes a new code (some of its copies stopped working and the run replaces codes). */
  rotate: boolean;
}

/** What the run's policy change does to one pass, from the pass's live inputs. */
function plan(run: ApplyRun, loaded: LoadedPass, now: number, inherited: boolean): Plan {
  const { inputs, rows } = loaded;
  // An entitlement run starts from the plan as it was: the channels the plan blocked then.
  const planBefore = run.fromBlocked
    ? {
        entitlement: Object.fromEntries(run.fromBlocked.map((c) => [c, 'not_included' as const])),
      }
    : {};
  const before = effectiveChannels({ ...inputs, ...planBefore, template: run.from });
  const after = effectiveChannels({ ...inputs, template: run.to });
  const actions = channelTransition(before, after, {
    copies: new Set(rows.copies),
    retired: new Set(Object.keys(rows.retired) as Channel[]),
    ...(rotating(run) ? { replaceCodes: new Set(run.replace) } : {}),
  });
  const flips: ApplyEvent[] = CHANNELS.filter((c) => before[c].on !== after[c].on).map(
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
  // A new code republishes the pass: one push, shared with an Apple bump.
  const rotate = actions.some((a) => a.kind === 'rotate_codes');
  if (rotate) {
    cost.rotations = 1;
    if (!appleChanged) add('apple');
  }
  // The republish also refreshes an active Google object (N4).
  if ((appleChanged || rotate) && rows.copies.includes('google') && after.google.on) add('google');
  const voidPrints = actions.some((a) => a.kind === 'void_prints');
  // A run that inherited a failed run's start may find passes that run already handled: only a channel
  // whose marker (or print) changes here is news.
  const events =
    inherited && run.fromBlocked === null
      ? flips.filter(
          (e) =>
            marks.some((m) => m.channel === e.channel) || (voidPrints && e.channel === 'paper'),
        )
      : flips;
  // A pass owed only a new code still gets its mark: it carries the notice and makes a retry safe.
  const empty = events.length === 0 && marks.length === 0 && !voidPrints && !rotate;
  return { write: empty ? null : { rows: marks, events, voidPrints }, cost, appleChanged, rotate };
}

/** Queues the republish that carries an Apple flip; the job skips when a publish got there first. */
async function queueAppleBump(ctx: ServiceContext, passId: string): Promise<void> {
  const current = await getPass(ctx.env.DB, passId);
  if (!current) return;
  await ctx.env.JOBS.send({ kind: 'channel.apple_bump', passId, version: current.version });
}

/** What a new code did for a pass: the totals it adds. */
type Rotated = Pick<ApplyCounts, 'rotated' | 'unsupported'>;

/**
 * Issues the pass's new code (once per run: a retry finds the mark) and tells the holder once. A
 * barcode that is not the scan code is counted and skipped.
 */
async function rotate(
  ctx: ServiceContext,
  run: ApplyRun,
  passId: string,
  notify: boolean,
): Promise<Rotated> {
  const result = await rotateCode(ctx, passId, `channel_apply:${run.id}`);
  if (result === 'unsupported') return { rotated: 0, unsupported: 1 };
  if (result === 'inactive') return { rotated: 0, unsupported: 0 };
  if (notify) {
    await noticeHolder(ctx, passId);
    await writeNotice(ctx, run, passId);
  }
  return { rotated: result === 'rotated' ? 1 : 0, unsupported: 0 };
}

/**
 * A pass this run already marked (a retried page): only the republish a lost message left, and the
 * new code or notice a crash left undone.
 */
async function finishMarked(
  ctx: ServiceContext,
  run: ApplyRun,
  inherited: boolean,
  pass: PagePass,
  loaded: LoadedPass | undefined,
  events: ApplyEvent[],
  owesNotice: boolean,
): Promise<Rotated> {
  if (events.some((e) => e.channel === 'apple')) {
    const current = await getPass(ctx.env.DB, pass.id);
    if (current && (loaded?.rows.setAt.apple ?? 0) > current.modifiedAt)
      await ctx.env.JOBS.send({
        kind: 'channel.apple_bump',
        passId: pass.id,
        version: current.version,
      });
  }
  if (!loaded || !plan(run, loaded, ctx.clock.now(), inherited).rotate)
    return { rotated: 0, unsupported: 0 };
  return rotate(ctx, run, pass.id, owesNotice);
}

async function page(ctx: ServiceContext, run: ApplyRun, inherited: boolean): Promise<PageResult> {
  const db = ctx.env.DB;
  await journal(ctx, run);
  // A window can open mid-page: a replace run takes few passes at a time, so it overshoots by few.
  const size = rotating(run) ? REPLACE_PAGE_SIZE : PAGE_SIZE;
  const passes = await passPage(db, run, size);
  if (passes.length === 0) return { done: true };
  const ids = passes.map((p) => p.id);
  const [loaded, marks, revisions, budget, owing] = await Promise.all([
    loadMany(ctx, passes),
    marksOf(db, run.id, ids),
    channelRevisions(db, ids),
    PageBudget.open(db, ctx.clock.now()),
    unnoticed(db, run.id, ids),
  ]);
  let counts: ApplyCounts = { ...run.counts };
  let cursor: string | null = null;
  let wait: number | undefined;
  let stopped = false;
  let spent = false;

  for (const pass of passes) {
    const marked = marks.get(pass.id);
    if (marked) {
      const r = await finishMarked(
        ctx,
        run,
        inherited,
        pass,
        loaded.get(pass.id),
        marked,
        owing.has(pass.id),
      );
      counts = {
        ...counts,
        rotated: counts.rotated + r.rotated,
        unsupported: counts.unsupported + r.unsupported,
      };
      cursor = pass.id;
      continue;
    }
    let state = loaded.get(pass.id);
    let seen = revisions.get(pass.id) ?? {};
    let done = false;
    for (let attempt = 0; attempt < 2 && !done && state; attempt++) {
      const p = plan(run, state, ctx.clock.now(), inherited);
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
        changed: counts.changed + (p.write.rows.length > 0 || p.write.events.length > 0 ? 1 : 0),
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
      if (p.rotate) {
        const r = await rotate(ctx, run, pass.id, true);
        counts = {
          ...counts,
          rotated: counts.rotated + r.rotated,
          unsupported: counts.unsupported + r.unsupported,
        };
      }
      done = true;
    }
    if (stopped) break;
    if (!done) counts = { ...counts, stale: counts.stale + 1 };
    cursor = pass.id;
  }

  await journal(ctx, run);
  if (cursor) await writeCursor(ctx, run, cursor, counts);
  if (!stopped && passes.length < size) return { done: true };
  const rest = spent && size === PAGE_SIZE ? REST_AFTER_WORK : REST_IDLE;
  return { done: false, wait: wait ?? rest };
}

/** One page of the run, at most 100 passes. A refusal of the org ends the run as inactive. */
export async function applyChannelPage(ctx: ServiceContext, runId: string): Promise<PageResult> {
  const run = await getRun(ctx.env.DB, runId);
  if (run?.state !== 'running' || !run.to) return { done: true };
  try {
    const begin = await effectiveFrom(ctx, run);
    return await page(
      ctx,
      { ...run, from: begin.from, fromBlocked: begin.fromBlocked },
      begin.viaFailed,
    );
  } catch (error) {
    if (isOrgRefusal(error)) return { done: true, failed: ORG_INACTIVE };
    throw error;
  }
}
