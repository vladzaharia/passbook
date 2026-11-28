import type { ReactElement } from 'react';
import { BENCH_COPY } from '../../../../shared/copy/developers-bench.ts';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { PATHS } from '../../../../shared/developers.ts';
import type { Session } from '../session.ts';
import { LazyFailed, LazyStage } from './lazy-state.tsx';

const C = CONSOLE_COPY;

/**
 * What a session without a ready sandbox shows: a state card with the one action, or null when the
 * sandbox is ready. The check that makes a sandbox runs on the Console tool alone (its CSP admits the
 * widget), which brings it as `create`; a reference page's Try it sends you there instead.
 */
export function sessionState(
  session: Exclude<Session, { kind: 'out' }>,
  create?: ReactElement,
): ReactElement | null {
  if (session.kind === 'failed')
    return <LazyFailed reason={C.sandboxFailed} onRetry={() => location.reload()} />;
  if (session.kind === 'none')
    return create ? (
      <LazyStage scene="wave" title={BENCH_COPY.state.noSandbox} action={create} />
    ) : (
      <LazyStage
        scene="wave"
        title={BENCH_COPY.state.noSandbox}
        action={
          <a className="btn" href={PATHS.console}>
            {C.create}
          </a>
        }
      />
    );
  if (session.kind === 'closed')
    return (
      <LazyStage
        scene="beat"
        mood="flat"
        title={C.closed}
        action={
          <a className="btn" href={`${PATHS.quickstart}#start-over`}>
            {C.startOver}
          </a>
        }
      />
    );
  return null;
}
