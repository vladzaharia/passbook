import type { PassView } from '@/shared/pass-view/index.ts';
import type { MyPass } from './pass-view.ts';

/** Voided, removed or expired: no longer the holder's to use. */
export const isEnded = (p: MyPass, view: PassView) =>
  p.status === 'voided' || p.removedAt !== null || view.voided || view.expired;

export interface StackGroups<T> {
  live: T[];
  test: T[];
  ended: T[];
}

/** My passes' three groups, each in the list's order (newest first). */
export function groupPasses<T extends { pass: MyPass; view: PassView }>(
  items: readonly T[],
): StackGroups<T> {
  const groups: StackGroups<T> = { live: [], test: [], ended: [] };
  for (const item of items) {
    if (isEnded(item.pass, item.view)) groups.ended.push(item);
    else if (item.pass.mode === 'test') groups.test.push(item);
    else groups.live.push(item);
  }
  return groups;
}

// A relevant date with no end stays relevant this long after it starts (Wallet's lock screen).
const GRACE_MS = 4 * 60 * 60 * 1000;

const ms = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);

/** The soonest start among the pass's relevant dates and events that has not ended yet. */
export function nextRelevant(pass: MyPass, view: PassView, now: number): number | null {
  const windows: [number, number][] = [];
  const add = (start: number, end: number) => {
    if (Number.isFinite(start))
      windows.push([start, Number.isFinite(end) ? end : start + GRACE_MS]);
  };
  add(ms(view.relevantDate), Number.NaN);
  const dates = pass.passJson.relevantDates;
  if (Array.isArray(dates)) {
    for (const d of dates as Record<string, unknown>[]) {
      add(ms(d?.startDate ?? d?.date ?? d?.relevantDate), ms(d?.endDate));
    }
  }
  for (const event of view.upcoming) if (event.dateTime) add(ms(event.dateTime), Number.NaN);
  let soonest: number | null = null;
  for (const [start, end] of windows) {
    if (end < now) continue;
    if (soonest === null || start < soonest) soonest = start;
  }
  return soonest;
}

/**
 * The front pass: the soonest relevant one of the first group that has any (live, then test,
 * then ended), otherwise that group's newest. Null with no passes.
 */
export function frontOf<T extends { pass: MyPass; view: PassView }>(
  groups: StackGroups<T>,
  now: number,
): T | null {
  const group = [groups.live, groups.test, groups.ended].find((g) => g.length > 0);
  if (!group) return null;
  let best: { item: T; at: number } | null = null;
  for (const item of group) {
    const at = nextRelevant(item.pass, item.view, now);
    if (at !== null && (best === null || at < best.at)) best = { item, at };
  }
  return best?.item ?? group[0] ?? null;
}
