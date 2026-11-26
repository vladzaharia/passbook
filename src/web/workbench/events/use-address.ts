import { useLocation, useRouter } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { bindBenchRouter } from '../bench/url.ts';

/** Where a step-up sign-in returns to: this view. */
export const useHere = (): string => useLocation({ select: (l) => l.href });

/** The Events address (`shared/workbench.ts`, `WbEventsLink`): the query the tool reads. */
export interface EventsParams {
  tab: 'events' | 'endpoints';
  /** The Add endpoint wizard is open. */
  add: boolean;
  type?: string;
  request?: string;
  pass?: string;
  /** With an event selected: the endpoint whose delivery is open. */
  endpoint?: string;
  /** With an event or an endpoint selected: the stored request that is open. */
  capture?: string;
}

const KEYS = ['type', 'request', 'pass', 'endpoint', 'capture'] as const;

/**
 * The tool's params from the router, so a wizard opened by a push and Back are read the same way
 * as a link. Writes go through the router too: filters and selection replace, the wizard pushes
 * (Back closes it). The bench's selection and filters write through the same router.
 */
export function useAddress() {
  const router = useRouter();
  const searchStr = useLocation({ select: (l) => l.searchStr });
  useLayoutEffect(() => {
    bindBenchRouter((href) => router.history.replace(href));
    return () => bindBenchRouter(null);
  }, [router]);
  const params = useMemo<EventsParams>(() => {
    const q = new URLSearchParams(searchStr);
    const found: EventsParams = {
      tab: q.get('tab') === 'endpoints' ? 'endpoints' : 'events',
      add: q.get('new') === '1',
    };
    for (const k of KEYS) {
      const v = q.get(k);
      if (v) found[k] = v;
    }
    return found;
  }, [searchStr]);

  const write = useCallback(
    (next: Record<string, string | null>, mode: 'push' | 'replace') => {
      const url = new URL(router.history.location.href, 'http://wb.invalid');
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '') url.searchParams.delete(k);
        else url.searchParams.set(k, v);
      }
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (mode === 'push') router.history.push(href);
      else router.history.replace(href);
    },
    [router],
  );
  return { params, write };
}
