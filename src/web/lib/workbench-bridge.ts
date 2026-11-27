import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { WB_AREA } from '@/shared/copy/workbench-shell.ts';
import {
  safeReturn,
  type WbPathOptions,
  type WbTool,
  wbPath,
  wbToolOf,
} from '@/shared/workbench.ts';
import { useMode } from './mode.ts';
import { useAdminScope } from './org-filter.tsx';

/** The admin side of the bridge (design §2.4): launch links out, and the way back in. */

/** A Workbench URL for this org that says where it was opened from. Never carries a body. */
export function bridgeHref(
  orgId: string,
  tool: WbTool,
  from: string,
  options: WbPathOptions = {},
): string {
  return wbPath(orgId, tool, {
    ...options,
    query: { ...options.query, from: 'admin', return: from },
  });
}

/**
 * The org a launch link may open: the page's own org, in any admin mode (the Workbench is always
 * Test). `records` is false in Live: records never deep-link there, and the Test tag hides.
 */
export function useWorkbenchBridge(): {
  orgId: string;
  records: boolean;
  href: (tool: WbTool, options?: WbPathOptions) => string;
} | null {
  const scope = useAdminScope();
  const mode = useMode();
  const here = useRouterState({ select: (s) => `${s.location.pathname}${s.location.searchStr}` });
  if (scope?.kind !== 'org') return null;
  const orgId = scope.orgId;
  return {
    orgId,
    records: mode === 'test',
    href: (tool, options) => bridgeHref(orgId, tool, here, options),
  };
}

export interface BridgeOrigin {
  return: string;
  /** Navigations since arrival. */
  hops: number;
}

const KEY = 'adm-origin';
export const QUIET_AFTER = 3;

export function readBridgeOrigin(): BridgeOrigin | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<BridgeOrigin>;
    const back = safeReturn(value.return);
    return back?.startsWith('/workbench') ? { return: back, hops: Number(value.hops) || 0 } : null;
  } catch {
    // A blocked or mangled store: no chip; the sidebar entry remains.
    return null;
  }
}

function write(origin: BridgeOrigin): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(origin));
  } catch {
    // Blocked storage: the chip shows on this page only.
    return;
  }
}

/** The Workbench page a launch link names, if it is one: `from=workbench&return=/workbench/…`. */
export function bridgeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const back = safeReturn(params.get('return'));
  return params.get('from') === 'workbench' && back?.startsWith('/workbench') ? back : null;
}

/** A full load that followed a Workbench link (its own link-outs carry no `from`). */
function fromReferrer(): string | null {
  try {
    const kind = (
      performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    )?.type;
    if (kind !== 'navigate' || !document.referrer) return null;
    const url = new URL(document.referrer);
    if (url.origin !== window.location.origin) return null;
    const back = safeReturn(`${url.pathname}${url.search}`);
    return back?.startsWith('/workbench/') || back === '/workbench' ? back : null;
  } catch {
    return null;
  }
}

/** The chip's words: the Workbench tool the person came from, else "Workbench". */
export function bridgeLabel(back: string): string {
  const tool = wbToolOf(back);
  return tool ? WB_AREA[tool].title : 'Workbench';
}

/**
 * The chip's state for admin: arrival with launch params (or a Workbench referrer) stores the way
 * back for this tab and takes the params out of the address; each later change of path is a hop.
 */
export function useBridgeOrigin(): BridgeOrigin | null {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [origin, setOrigin] = useState<BridgeOrigin | null>(() => readBridgeOrigin());
  const last = useRef<string | null>(null);
  useEffect(() => {
    const first = last.current === null;
    const previous = last.current;
    last.current = pathname;
    const arrived = bridgeFromSearch(searchStr) ?? (first ? fromReferrer() : null);
    if (arrived) {
      const next = { return: arrived, hops: 0 };
      write(next);
      setOrigin(next);
      const params = new URLSearchParams(searchStr);
      if (params.has('from') || params.has('return')) {
        params.delete('from');
        params.delete('return');
        const rest = params.toString();
        router.history.replace(`${pathname}${rest ? `?${rest}` : ''}${hash ? `#${hash}` : ''}`);
      }
      return;
    }
    if (previous === null || previous === pathname) return;
    setOrigin((current) => {
      if (!current) return current;
      const next = { ...current, hops: current.hops + 1 };
      write(next);
      return next;
    });
  }, [pathname, searchStr, hash, router]);
  return origin;
}
