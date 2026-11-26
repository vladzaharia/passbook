import { useEffect, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { PATHS } from '../../../../shared/developers.ts';
import { BenchState } from '../../bench/state.tsx';
import { loadIndex } from '../data.ts';
import type { Session } from '../session.ts';
import { ConsolePage } from './console-page.tsx';
import { CreateSandbox } from './create-sandbox.tsx';
import { Ready } from './ready.tsx';

const C = CONSOLE_COPY;

export interface RunAppProps {
  session: Exclude<Session, { kind: 'out' }>;
  mode: 'op' | 'console' | 'sheet';
  slug?: string | undefined;
  opId?: string | undefined;
}

/** The Run island: the Console tool (`console`), or one operation's console on a reference page (`op`, `sheet`). */
export function RunApp({ session, mode, slug, opId }: RunAppProps) {
  const [codes, setCodes] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (mode === 'console') return;
    void loadIndex().then(
      (i) => setCodes(new Set(i.codes)),
      (error: unknown) => reportError(error),
    );
  }, [mode]);
  // The check that makes a sandbox runs on the console page alone (its CSP admits the widget).
  if (session.kind === 'none' && mode !== 'console')
    return (
      <BenchState scene="no-sandbox" heading="h3">
        <a className="btn" href={PATHS.console}>
          {C.create}
        </a>
      </BenchState>
    );
  if (session.kind === 'failed')
    return <BenchState scene="failed" title={C.sandboxFailed} onRetry={() => location.reload()} />;
  if (session.kind === 'none')
    return (
      <BenchState scene="no-sandbox">
        <CreateSandbox
          csrf={session.csrf}
          siteKey={session.siteKey}
          onReady={() => {
            // A fresh document: the Turnstile script does not stay beside the tokens.
            location.reload();
          }}
        />
      </BenchState>
    );
  if (session.kind === 'closed')
    return (
      <BenchState scene="closed" title={C.closed}>
        <a className="btn" href={`${PATHS.quickstart}#start-over`}>
          {C.startOver}
        </a>
      </BenchState>
    );
  return mode === 'console' ? (
    <ConsolePage sandbox={session.sandbox} csrf={session.csrf} />
  ) : (
    <Ready
      sandbox={session.sandbox}
      csrf={session.csrf}
      mode={mode}
      slug={slug}
      opId={opId}
      codes={codes}
    />
  );
}
