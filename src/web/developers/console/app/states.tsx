import type { ReactElement } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { PATHS } from '../../../../shared/developers.ts';
import type { Session } from '../session.ts';
import { LazyState } from './lazy-state.tsx';

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
    return <LazyState scene="failed" title={C.sandboxFailed} onRetry={() => location.reload()} />;
  if (session.kind === 'none')
    return create ? (
      <LazyState scene="no-sandbox">{create}</LazyState>
    ) : (
      <LazyState scene="no-sandbox" heading="h3">
        <a className="btn" href={PATHS.console}>
          {C.create}
        </a>
      </LazyState>
    );
  if (session.kind === 'closed')
    return (
      <LazyState scene="closed" title={C.closed}>
        <a className="btn" href={`${PATHS.quickstart}#start-over`}>
          {C.startOver}
        </a>
      </LazyState>
    );
  return null;
}
