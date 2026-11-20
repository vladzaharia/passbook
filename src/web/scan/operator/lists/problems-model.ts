/**
 * Problems: refusals and holds from the last 15 minutes that someone can still act on, and the
 * ones already settled. The server's activity page says what each scan was, not what overrode
 * it, so a problem counts as resolved when the same pass was let in afterwards, or someone here
 * let it in or marked it seen.
 */
import type { ActivityItem } from './activity-model.ts';

export const PROBLEM_MS = 15 * 60_000;

export interface Settled {
  /** Who settled it on this device, when it was not seen in the page. */
  by: string | null;
  how: 'let_in' | 'seen';
}

export interface Problem {
  item: ActivityItem;
  /** A refusal that named a pass can be let in. An unknown code can only be seen. */
  canLetIn: boolean;
}

export interface ResolvedProblem {
  item: ActivityItem;
  /** Who let them in, when the page says. */
  by: string | null;
  how: 'let_in' | 'seen';
}

const isProblem = (item: ActivityItem) => item.outcome === 'refused' || item.outcome === 'heads_up';

export function problemsOf(
  items: readonly ActivityItem[],
  now: number,
  settled: ReadonlyMap<string, Settled>,
): { open: Problem[]; resolved: ResolvedProblem[] } {
  const open: Problem[] = [];
  const resolved: ResolvedProblem[] = [];
  for (const item of items) {
    if (!isProblem(item)) continue;
    const mine = settled.get(item.id);
    const later = item.passId
      ? items.find((o) => o.outcome === 'ok' && o.passId === item.passId && o.at > item.at)
      : undefined;
    if (mine) resolved.push({ item, by: mine.by, how: mine.how });
    else if (later) resolved.push({ item, by: later.staff, how: 'let_in' });
    else if (now - item.at < PROBLEM_MS)
      open.push({ item, canLetIn: item.passId !== null && item.scanId !== null });
  }
  return { open, resolved };
}
