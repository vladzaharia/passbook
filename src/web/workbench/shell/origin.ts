import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { safeReturn, WB_ORIGINS, type WbOrigin } from '@/shared/workbench.ts';

/**
 * Where a launch link came from (design §2.4, UM4). `from=<space>&return=<path>` on arrival is
 * copied to this tab's `sessionStorage`, so client navigation keeps the chip; a lost store shows
 * none. After three navigations away it turns quiet. A `return` outside admin, the docs or the
 * Workbench is ignored.
 */
export interface Origin {
  from: WbOrigin;
  return: string;
  /** Navigations since arrival. */
  hops: number;
}

const KEY = 'wb-origin';
export const QUIET_AFTER = 3;

export function readOrigin(): Origin | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Origin>;
    const back = safeReturn(value.return);
    if (!back || !WB_ORIGINS.includes(value.from as WbOrigin)) return null;
    return { from: value.from as WbOrigin, return: back, hops: Number(value.hops) || 0 };
  } catch {
    // A blocked or mangled store: no chip; the sidebar's ways out remain.
    return null;
  }
}

function writeOrigin(origin: Origin): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(origin));
  } catch {
    // Blocked storage: the chip shows on this page only.
    return;
  }
}

/** A launch link's params, if both are valid. */
export function originFromSearch(search: string): Omit<Origin, 'hops'> | null {
  const params = new URLSearchParams(search);
  const from = params.get('from');
  const back = safeReturn(params.get('return'));
  if (!from || !back || !WB_ORIGINS.includes(from as WbOrigin)) return null;
  return { from: from as WbOrigin, return: back };
}

const ADMIN_PAGES: [RegExp, string][] = [
  [/\/connections\/webhooks\/[^/]+/, 'Webhook endpoint'],
  [/\/passes\/[^/]+/, 'Pass'],
  [/\/api-keys\/[^/]+/, 'API key'],
  [/\/templates\/[^/]+/, 'Template'],
  [/\/test-inbox/, 'Test inbox'],
  [/\/connections/, 'Connections'],
];
const DOCS_PAGES: [RegExp, string][] = [
  [/^\/developers\/reference/, 'Reference'],
  [/^\/developers\/errors\//, 'Error'],
  [/^\/developers\/guides\//, 'Guide'],
  [/^\/developers\/changelog/, 'Changelog'],
];

/** The chip's words: the origin page's kind ("Webhook endpoint"), else the space ("Admin", "Docs"). */
export function originLabel(origin: Pick<Origin, 'from' | 'return'>): string {
  const path = origin.return.split(/[?#]/, 1)[0] ?? '';
  const table = origin.from === 'admin' ? ADMIN_PAGES : DOCS_PAGES;
  return table.find(([re]) => re.test(path))?.[1] ?? (origin.from === 'admin' ? 'Admin' : 'Docs');
}

/**
 * The chip's state for the shell. Arrival with launch params stores them and takes them out of the
 * address (replace); each later change of path is a hop. Filters and selection are not.
 */
export function useOrigin(): Origin | null {
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const [origin, setOrigin] = useState<Origin | null>(() => readOrigin());
  const lastPath = useRef<string | null>(null);
  const { pathname, searchStr, hash } = location;
  useEffect(() => {
    const arrived = originFromSearch(searchStr);
    if (arrived) {
      const next = { ...arrived, hops: 0 };
      writeOrigin(next);
      setOrigin(next);
      lastPath.current = pathname;
      const params = new URLSearchParams(searchStr);
      params.delete('from');
      params.delete('return');
      const rest = params.toString();
      router.history.replace(`${pathname}${rest ? `?${rest}` : ''}${hash ? `#${hash}` : ''}`);
      return;
    }
    const previous = lastPath.current;
    lastPath.current = pathname;
    if (previous === null || previous === pathname) return;
    setOrigin((current) => {
      if (!current) return current;
      const next = { ...current, hops: current.hops + 1 };
      writeOrigin(next);
      return next;
    });
  }, [pathname, searchStr, hash, router]);
  return origin;
}
