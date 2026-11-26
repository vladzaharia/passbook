import { createRoot } from 'react-dom/client';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchState } from '../bench/state.tsx';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { LogsTool } from './logs-tool.tsx';
import { migrateHash } from './model.ts';

/**
 * The Logs island, on the bench. Signed out the prerendered gate stays and nothing is asked of the API;
 * without a sandbox there is no log to ask for, so no call is made either.
 */
export const logsIsland: Island = {
  mount: async (el) => {
    const session = await loadSession();
    if (session.kind === 'out') return;
    const root = createRoot(el);
    if (session.kind === 'ready') {
      migrateHash();
      root.render(<LogsTool />);
    } else if (session.kind === 'failed') {
      root.render(<BenchState scene="failed" onRetry={() => location.reload()} />);
    } else {
      root.render(
        <BenchState scene={session.kind === 'closed' ? 'closed' : 'no-sandbox'}>
          {session.kind === 'closed' ? null : (
            <a className="btn" href={`${PATHS.quickstart}#sandbox`}>
              {BENCH_COPY.strip.create}
            </a>
          )}
        </BenchState>,
      );
    }
  },
};
