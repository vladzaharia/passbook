import { useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import type { CodeLang } from '../playground/hash.ts';
import { Seg } from '../playground/seg.tsx';
import { CodeBlock } from './code-block.tsx';
import { createCode } from './model.ts';
import { Step, type StepState } from './parts.tsx';
import { RunBar } from './run-bar.tsx';
import { TerminalBar } from './terminal-bar.tsx';
import type { Quickstart } from './use-quickstart.ts';

const C = QS_COPY.steps;
const T = QS_COPY.call;
const apiBase = () => `${location.origin}/api/v1`;

type Where = 'terminal' | 'here';
const WHERE: { value: Where; label: string }[] = [
  { value: 'terminal', label: T.terminal },
  { value: 'here', label: T.here },
];

/**
 * First call. The default is your terminal: the page listens for a call from any key of the sandbox and draws the
 * pass when it arrives. Run here is the same request from this page, for a browser with no terminal at hand.
 */
export function RunStep({
  q,
  lang,
  onLang,
  state,
}: {
  q: Quickstart;
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  state: StepState;
}) {
  const [where, setWhere] = useState<Where>('terminal');
  const { templateId, input, run } = q;
  const ready = Boolean(q.sandbox && templateId && input);
  const codes = templateId && input ? createCode(templateId, input, apiBase()) : [];
  const open = state === 'current' && ready;
  return (
    <Step n={3} state={state} title={C.run.title}>
      <p className="sm muted">
        {C.run.line} <code className="inline-code">{q.template?.name ?? 'Quickstart ticket'}</code>.{' '}
        {C.run.line2}
      </p>
      {q.sandbox ? (
        <Seg
          label={T.mode}
          value={where}
          options={WHERE}
          onChange={setWhere}
          className="qs-where"
        />
      ) : null}
      <div className="qs-ticket">
        {codes.length > 0 ? (
          <CodeBlock
            codes={codes}
            lang={lang}
            onLang={onLang}
            lit={['input', 'attendee', 'ticketId']}
            base="create"
          />
        ) : (
          <div className="code qs-code qs-code-ghost" aria-hidden="true">
            <div className="bars">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {!q.sandbox ? null : where === 'terminal' ? (
          <TerminalBar
            q={q}
            active={open}
            done={state === 'done'}
            onHere={() => setWhere('here')}
          />
        ) : (
          <RunBar
            call={run}
            sending={C.run.sending}
            runLabel={C.run.run}
            againLabel={C.run.again}
            disabled={!ready}
            onRun={() => void q.create()}
            replayNote={C.run.replayed}
          />
        )}
      </div>
    </Step>
  );
}
