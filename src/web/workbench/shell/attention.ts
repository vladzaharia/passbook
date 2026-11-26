import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ATTENTION_LABEL } from '@/shared/copy/workbench-shell.ts';
import { WB_TOOLS, type WbTool } from '@/shared/workbench.ts';
import type { SeenArea, WbSummary } from '../host/summary.ts';
import { personKey } from './person.ts';

/**
 * The nav shows attention, never totals (design §1.6). Each item's meta, what it reads as in its
 * link's name, and whether it is danger (the area button's dot below 1024).
 */
export type Attention =
  | { kind: 'progress'; done: number; total: number; label: string }
  | { kind: 'danger'; value: number; label: string }
  | { kind: 'count'; value: number; label: string }
  | { kind: 'running'; value: number; label: string }
  | { kind: 'live'; label: string }
  | { kind: 'warn'; label: string };

export type AttentionMap = Partial<Record<WbTool, Attention>>;

export function navAttention(summary: WbSummary | undefined, running: number): AttentionMap {
  const map: AttentionMap = {};
  if (running > 0)
    map.activity = { kind: 'running', value: running, label: ATTENTION_LABEL.running(running) };
  if (!summary) return map;
  const { quickstart: qs, errors, failedDeliveries, listening, inboxNew, keysExpiring } = summary;
  if (qs && qs.done < qs.total)
    map.quickstart = {
      kind: 'progress',
      done: qs.done,
      total: qs.total,
      label: ATTENTION_LABEL.quickstart(qs.done, qs.total),
    };
  if (errors > 0)
    map.logs = { kind: 'danger', value: errors, label: ATTENTION_LABEL.errors(errors) };
  if (failedDeliveries > 0)
    map.events = {
      kind: 'danger',
      value: failedDeliveries,
      label: ATTENTION_LABEL.failedDeliveries(failedDeliveries),
    };
  else if (listening) map.events = { kind: 'live', label: ATTENTION_LABEL.listening };
  if (inboxNew > 0)
    map.inbox = { kind: 'count', value: inboxNew, label: ATTENTION_LABEL.inboxNew(inboxNew) };
  if (keysExpiring > 0) map.keys = { kind: 'warn', label: ATTENTION_LABEL.keyExpiring };
  return map;
}

/** The first area, in nav order and other than this one, whose meta is danger. */
export function firstDanger(map: AttentionMap, here: WbTool | null): WbTool | null {
  return WB_TOOLS.find((t) => t !== here && map[t]?.kind === 'danger') ?? null;
}

/** Quickstart moves to the foot once it is done (US3): done means the summary says so. */
export const quickstartDone = (summary: WbSummary | undefined): boolean =>
  Boolean(summary?.quickstart && summary.quickstart.done >= summary.quickstart.total);

// Seen marks: per org and area, the newest counted row's time this person has seen. They ride as
// `since[area]` on the summary. Navigation alone never sets one, and a failed load never does.
const seenKey = (orgId: string) => `${personKey('wb-seen')}:${orgId}`;
const subs = new Set<() => void>();
const snapshots = new Map<
  string,
  { raw: string | null; value: Partial<Record<SeenArea, number>> }
>();

function read(orgId: string): Partial<Record<SeenArea, number>> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(seenKey(orgId));
  } catch {
    raw = null;
  }
  const cached = snapshots.get(seenKey(orgId));
  if (cached && cached.raw === raw) return cached.value;
  let value: Partial<Record<SeenArea, number>> = {};
  try {
    value = raw ? (JSON.parse(raw) as Partial<Record<SeenArea, number>>) : {};
  } catch {
    // A mangled mark counts everything again: never fewer than there are.
    value = {};
  }
  snapshots.set(seenKey(orgId), { raw, value });
  return value;
}

/** Records that the newest row up to `at` was seen. Marks only move forward. */
export function markSeen(orgId: string, area: SeenArea, at: number): void {
  const marks = read(orgId);
  if ((marks[area] ?? 0) >= at) return;
  try {
    localStorage.setItem(seenKey(orgId), JSON.stringify({ ...marks, [area]: at }));
  } catch {
    // Blocked storage: the count stays until the next visit can store it.
    return;
  }
  for (const sub of subs) sub();
}

export function useSeenMarks(orgId: string | undefined): Partial<Record<SeenArea, number>> {
  return useSyncExternalStore(
    (sub) => {
      subs.add(sub);
      addEventListener('storage', sub);
      return () => {
        subs.delete(sub);
        removeEventListener('storage', sub);
      };
    },
    () => (orgId ? read(orgId) : EMPTY),
    () => EMPTY,
  );
}
const EMPTY: Partial<Record<SeenArea, number>> = {};

/** How long the newest counted row must stay in view before it counts as seen. */
export const SEEN_DWELL_MS = 1000;

/**
 * A tool's list calls this on its newest counted row once the list has rendered: in view for a
 * second, it marks the area seen up to `at`. A list still loading, or failed, passes no element.
 */
export function useSeenOnView(
  orgId: string,
  area: SeenArea,
  element: Element | null,
  at: number | undefined,
): void {
  useEffect(() => {
    if (!element || at === undefined || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry?.isIntersecting) timer = setTimeout(() => markSeen(orgId, area, at), SEEN_DWELL_MS);
    });
    io.observe(element);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [orgId, area, element, at]);
}

/**
 * A one-shot "arrive" when a value rises (design §1.6): the returned number changes only then, so
 * a keyed child replays its animation once. The first value, a fall and a repeat never play it.
 */
export function useArrive(value: number | undefined): number {
  const previous = useRef(value);
  const [arrivals, setArrivals] = useState(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before !== undefined && value !== undefined && value > before) setArrivals((n) => n + 1);
  }, [value]);
  return arrivals;
}
