import { useEffect, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchCode } from '../bench/code-block.tsx';
import { BenchState } from '../bench/state.tsx';
import { LOG_API } from './model.ts';

const S = LOGS_BENCH_COPY.state;

/** The one call to make first: a read any sandbox key may make, with the key from the environment. */
const firstCall = (origin: string) =>
  `curl ${origin}/api/v1/passes?limit=1 \\\n  -H "Authorization: Bearer $PASSBOOK_KEY"`;

/** How many calls exist from the portal (Run here, its own reads): the default view hides them. */
function usePortalCalls(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(`${LOG_API}?source=try&limit=100`, { headers: { accept: 'application/json' } })
      .then(async (res) => (res.ok ? ((await res.json()) as { items: unknown[] }).items.length : 0))
      .then((n) => live && setCount(n))
      .catch((error: unknown) => {
        // The empty state shows without the hint; the page's handler hears why.
        reportError(error);
      });
    return () => {
      live = false;
    };
  }, []);
  return count;
}

/**
 * Nothing logged yet: the buddy looks over the empty log, and the card holds the one thing to do next, the call
 * itself ready to copy, or the way to a key when there is none. Calls from the portal alone are said and shown
 * in one tap.
 */
export function FirstCall({ hasKey, onShowPortal }: { hasKey: boolean; onShowPortal: () => void }) {
  const portal = usePortalCalls();
  if (portal > 0)
    return (
      <BenchState scene="logs-idle" title={S.hidden(portal)}>
        <button type="button" className="btn outline" onClick={onShowPortal}>
          {S.showHidden}
        </button>
      </BenchState>
    );
  return (
    <BenchState scene="logs-idle" title={hasKey ? undefined : S.noCalls}>
      {hasKey ? (
        <div className="logs-first">
          <BenchCode label="curl" lang="curl" body={firstCall(location.origin)} empty={S.noCalls} />
        </div>
      ) : (
        <p className="sm muted">{S.noKey}</p>
      )}
      <div className="logs-first-a">
        {hasKey ? null : (
          <a className="btn" href={PATHS.keys}>
            {S.makeKey}
          </a>
        )}
        <a className={hasKey ? 'btn' : 'btn outline'} href={PATHS.console}>
          {S.console}
        </a>
      </div>
    </BenchState>
  );
}

/** Filters that match nothing: the way back. */
export function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <BenchState scene="no-match">
      <button type="button" className="btn outline" onClick={onClear}>
        {BENCH_COPY.state.clearFilters}
      </button>
    </BenchState>
  );
}
