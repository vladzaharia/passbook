import { useLocation, useRouter } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { bindBenchRouter } from '../bench/url.ts';
import { isTab, type PassTab } from './model.ts';

export interface PassesParams {
  /** The pass's inspector tab. */
  tab: PassTab;
  /** `phone`: the On my phone view. */
  view: 'all' | 'phone';
}

/**
 * The Passes address (`shared/workbench.ts`): `passes?view=phone&tab=devices#<passId>`. The router
 * writes it, so the bench's selection, Back and the shell stay in step; every write replaces.
 */
export function useAddress() {
  const router = useRouter();
  const searchStr = useLocation({ select: (l) => l.searchStr });
  useLayoutEffect(() => {
    bindBenchRouter((href) => router.history.replace(href));
    return () => bindBenchRouter(null);
  }, [router]);
  const params = useMemo<PassesParams>(() => {
    const q = new URLSearchParams(searchStr);
    const tab = q.get('tab');
    return { tab: isTab(tab) ? tab : 'events', view: q.get('view') === 'phone' ? 'phone' : 'all' };
  }, [searchStr]);
  const write = useCallback(
    (next: Record<string, string | null>) => {
      const url = new URL(router.history.location.href, 'http://wb.invalid');
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '') url.searchParams.delete(k);
        else url.searchParams.set(k, v);
      }
      router.history.replace(`${url.pathname}${url.search}${url.hash}`);
    },
    [router],
  );
  return { params, write };
}
