import type { ReactElement } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { PATHS } from '../../../../shared/developers.ts';
import type { Session } from '../session.ts';
import { CreateSandbox } from './create-sandbox.tsx';
import { LazyState } from './lazy-state.tsx';

const C = CONSOLE_COPY;

/**
 * What a session without a ready sandbox shows, on the Console tool (`tool`) or on a reference page's
 * Try it: a state card with the one action, or null when the sandbox is ready. The check that makes a
 * sandbox runs on the Console tool alone (its CSP admits the widget); a reference page sends you there.
 */
export function sessionState(
  session: Exclude<Session, { kind: 'out' }>,
  tool: boolean,
): ReactElement | null {
  if (session.kind === 'failed')
    return <LazyState scene="failed" title={C.sandboxFailed} onRetry={() => location.reload()} />;
  if (session.kind === 'none')
    return tool ? (
      <LazyState scene="no-sandbox">
        <CreateSandbox
          csrf={session.csrf}
          siteKey={session.siteKey}
          onReady={() => {
            // A fresh document: the Turnstile script does not stay beside the tokens.
            location.reload();
          }}
        />
      </LazyState>
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
