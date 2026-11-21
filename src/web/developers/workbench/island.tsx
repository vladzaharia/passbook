import { useCallback, useEffect, useState } from 'react';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { fetchCalls, fetchHome, HomeError } from './api.ts';
import { Workbench, type WorkbenchLinks } from './workbench.tsx';

const WAVED = 'pb-dev-wb-waved';

/** True once per browser session: the buddy waves on the first visit only. */
function firstVisit(): boolean {
  try {
    if (sessionStorage.getItem(WAVED)) return false;
    sessionStorage.setItem(WAVED, '1');
    return true;
  } catch {
    // Storage blocked (private mode, a sandboxed frame): wave every time rather than never.
    return true;
  }
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; home: DeveloperHome }
  | { kind: 'failed'; out: boolean };

/** Loads `GET /developer/home` and renders the workbench, or a one-line failure with Retry. */
export function WorkbenchIsland({
  fetchFn = (input, init) => fetch(input, init),
  links,
  initial,
}: {
  fetchFn?: typeof fetch;
  links?: WorkbenchLinks;
  /** A home the mount already read: no second request on first paint. */
  initial?: DeveloperHome;
}) {
  const [load, setLoad] = useState<Load>(
    initial ? { kind: 'ready', home: initial } : { kind: 'loading' },
  );
  const [wave] = useState(firstVisit);
  const read = useCallback(() => {
    setLoad({ kind: 'loading' });
    fetchHome(fetchFn).then(
      (home) => setLoad({ kind: 'ready', home }),
      (error: unknown) => setLoad({ kind: 'failed', out: error instanceof HomeError && error.out }),
    );
  }, [fetchFn]);
  /** After a reset or reopen: the new home replaces the old one in place, with no loading flash. */
  const refresh = useCallback(() => {
    fetchHome(fetchFn).then(
      (home) => setLoad({ kind: 'ready', home }),
      () => undefined,
    );
  }, [fetchFn]);
  const [first] = useState(initial === undefined);
  useEffect(() => {
    if (first) read();
  }, [first, read]);
  if (load.kind === 'loading')
    return (
      <p className="wb-loading sm muted" aria-busy>
        Loading your workbench…
      </p>
    );
  if (load.kind === 'failed')
    return load.out ? (
      <p className="wb-loading sm muted">
        No developer access. Ask an administrator for developer access.
      </p>
    ) : (
      <p className="wb-loading sm muted">
        Your workbench did not load.{' '}
        <button type="button" className="btn sm outline" onClick={read}>
          Retry
        </button>
      </p>
    );
  return (
    <Workbench
      home={load.home}
      loadCalls={(source) => fetchCalls(source, fetchFn)}
      wave={wave}
      onChanged={refresh}
      {...(links ? { links } : {})}
    />
  );
}
