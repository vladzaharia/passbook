import type { DeveloperFunnel } from '../../../shared/contracts/developer.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { funnelCounts, ttfpSamples, viewedAndPassed } from './repo-developer-funnel.ts';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
/** Enough for an exact percentile of a month of sandboxes; more would be a different question. */
const SAMPLE_CAP = 5000;

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * The quickstart funnel of the last 30 days' sandboxes (PX13): how many opened it, called, made a pass and saw it, and
 * the time from the page view to the first pass. Counts and times only; the read names no org and no person.
 */
export async function developerFunnel(ctx: ServiceContext): Promise<DeveloperFunnel> {
  const since = ctx.clock.now() - WINDOW_DAYS * DAY_MS;
  const db = ctx.env.DB;
  const [counts, samples, both] = await Promise.all([
    funnelCounts(db, since),
    ttfpSamples(db, since, SAMPLE_CAP),
    viewedAndPassed(db, since),
  ]);
  const viewed = counts?.viewed ?? 0;
  return {
    windowDays: WINDOW_DAYS,
    sandboxes: counts?.sandboxes ?? 0,
    viewed,
    called: counts?.called ?? 0,
    passed: counts?.passed ?? 0,
    previewed: counts?.previewed ?? 0,
    completion: viewed === 0 ? null : both / viewed,
    ttfpP50Ms: percentile(samples, 0.5),
    ttfpP90Ms: percentile(samples, 0.9),
    ttfpSamples: samples.length,
  };
}
