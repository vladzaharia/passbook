import { useEffect, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { WB_EMPTY } from '../../../shared/copy/workbench-states.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { useToolApi } from '../../lib/tool-api.tsx';
import { Button } from '../../ui/button.tsx';
import { BenchCode } from '../bench/code-block.tsx';
import { StageState } from '../states/states.tsx';
import { readLog } from './api.ts';

const S = LOGS_BENCH_COPY.state;

/** The one call to make first: a read any sandbox key may make, with the key from the environment. */
const firstCall = (origin: string) =>
  `curl ${origin}/api/v1/passes?limit=1 \\\n  -H "Authorization: Bearer $PASSBOOK_KEY"`;

/** How many calls exist from the portal (Run here, its own reads): the default view hides them. */
function usePortalCalls(): number {
  const api = useToolApi();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    readLog(api, { source: 'try' }, { signal: ctl.signal }).then(
      (page) => setCount(page.items.length),
      // The empty state shows without the hint.
      () => undefined,
    );
    return () => ctl.abort();
  }, [api]);
  return count;
}

/**
 * Nothing logged yet: the buddy looks over the empty log, and the card holds the one thing to do next, the call
 * itself ready to copy, or the way to a key when there is none. Calls from the portal alone are said and shown
 * in one tap.
 */
export function FirstCall({
  orgId,
  hasKey,
  onShowPortal,
}: {
  orgId: string;
  hasKey: boolean;
  onShowPortal: () => void;
}) {
  const portal = usePortalCalls();
  if (portal > 0)
    return (
      <StageState
        scene="inspect"
        mood="curious"
        title={S.hidden(portal)}
        action={
          <Button variant="outline" onClick={onShowPortal}>
            {S.showHidden}
          </Button>
        }
      />
    );
  return (
    <StageState
      scene="listen"
      mood="curious"
      title={(hasKey ? WB_EMPTY.logs?.title : S.noCalls) ?? S.noCalls}
    >
      {hasKey ? (
        <div className="logs-first w-full min-w-0 [&_.code]:max-w-full [&_.code]:overflow-x-auto">
          <BenchCode label="curl" lang="curl" body={firstCall(location.origin)} empty={S.noCalls} />
        </div>
      ) : (
        <p className="sm muted">{S.noKey}</p>
      )}
      <div className="logs-first-a">
        {hasKey ? null : (
          <Button asChild>
            <a href={wbPath(orgId, 'keys')}>{S.makeKey}</a>
          </Button>
        )}
        <Button asChild variant={hasKey ? 'primary' : 'outline'}>
          <a href={wbPath(orgId, 'console')}>{S.console}</a>
        </Button>
      </div>
    </StageState>
  );
}

/** Filters that match nothing: the way back. */
export function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <StageState
      scene="search"
      mood="curious"
      title={BENCH_COPY.state.noMatch}
      action={
        <Button variant="outline" onClick={onClear}>
          {BENCH_COPY.state.clearFilters}
        </Button>
      }
    />
  );
}
