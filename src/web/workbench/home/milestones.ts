import { useEffect, useRef, useState } from 'react';
import { personKey } from '../shell/person.ts';

export const MILESTONES = ['firstCall', 'onPhone', 'quickstart', 'webhook'] as const;
export type Milestone = (typeof MILESTONES)[number];
export type Signals = Partial<Record<Milestone, boolean>>;

const key = (orgId: string, id: Milestone) => personKey(`wb-milestone:${orgId}:${id}`);
/** Kept in memory when storage is blocked: the moment still fires once per page. */
const memory = new Set<string>();

export function milestoneSeen(orgId: string, id: Milestone): boolean {
  const k = key(orgId, id);
  if (memory.has(k)) return true;
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
}

function remember(orgId: string, id: Milestone): void {
  const k = key(orgId, id);
  memory.add(k);
  try {
    localStorage.setItem(k, '1');
  } catch {
    // Blocked storage: the in-memory mark above holds for this page.
  }
}

/** Visible for tests: forget this page's marks. */
export const forgetMilestones = (): void => memory.clear();

/**
 * The milestone to celebrate now, if any. A milestone fires when its signal turns true while Home is
 * open and has never fired for this sandbox; one already true on the first read is recorded silently,
 * so an old sandbox does not cheer for what it did last month. Each fires once, one at a time.
 */
export function useMilestone(orgId: string, signals: Signals, ready: boolean): Milestone | null {
  const [now, setNow] = useState<Milestone | null>(null);
  const prev = useRef<Signals | null>(null);
  useEffect(() => {
    if (!ready) return;
    const before = prev.current;
    prev.current = { ...signals };
    for (const id of MILESTONES) {
      if (!signals[id] || milestoneSeen(orgId, id)) continue;
      remember(orgId, id);
      if (before && !before[id]) {
        setNow(id);
        return;
      }
    }
  }, [orgId, signals, ready]);
  useEffect(() => {
    if (!now) return;
    const t = setTimeout(() => setNow(null), 2_600);
    return () => clearTimeout(t);
  }, [now]);
  return now;
}
