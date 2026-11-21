import { useCallback, useEffect, useRef, useState } from 'react';
import { Inspector } from '../../ui/inspector.tsx';
import { Ticket } from '../../ui/ticket.tsx';
import { remaining, subscribe } from '../budget.ts';
import { buildSent, type Draft, initialDraft } from '../request.ts';
import { type Outcome, RunError, send } from '../send.ts';
import type { RunOp } from '../types.ts';
import { Builder, type Tab } from './builder.tsx';
import { ResponseEmpty } from './response-empty.tsx';

export interface ConsoleProps {
  op: RunOp;
  origin: string;
  csrf: string;
  templateId: string | null;
  codes: ReadonlySet<string>;
  /** On the console page the stub grows with its content; on an operation page it is a fixed size. */
  mode: 'op' | 'console' | 'sheet';
}

const firstTab = (op: RunOp): Tab =>
  op.params.some((p) => p.where !== 'header') || !op.body ? 'form' : 'json';

/** One operation: the request as the ticket stub, the response as its body. Remounted per operation. */
export function OpConsole({ op, origin, csrf, templateId, codes }: ConsoleProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(op, templateId));
  const [tab, setTab] = useState<Tab>(() => firstTab(op));
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ result: Outcome; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spent, setSpent] = useState(() => remaining() === 0);
  const live = useRef(true);
  const pressRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    live.current = true;
    const off = subscribe(() => setSpent(remaining() === 0));
    return () => {
      live.current = false;
      off();
    };
  }, []);

  const execute = useCallback(
    async (d: Draft, again: boolean) => {
      setPending(true);
      setError(null);
      try {
        const result = await send(op, d, csrf);
        if (!live.current) return;
        setOutcome({ result, draft: d });
        // A call that went through spends its key: the next Run is a new call. "Same key" keeps it.
        if (!again && d.idemOn && result.status < 500)
          setDraft((cur) => ({ ...cur, idemKey: crypto.randomUUID() }));
      } catch (e) {
        if (live.current)
          setError(e instanceof RunError ? e.message : 'Something went wrong. Run again.');
      } finally {
        if (live.current) setPending(false);
      }
    },
    [op, csrf],
  );

  const run = () => void execute(draft, false);
  const replay = outcome ? () => void execute(outcome.draft, true) : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Cmd/Ctrl+Enter runs from anywhere in the console
    <div
      className="run-root"
      onKeyDown={(e) => {
        // Same gate as the button: validation, budget and the destructive second press.
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          pressRef.current?.();
        }
      }}
    >
      <Ticket
        stub={
          <Builder
            op={op}
            origin={origin}
            draft={draft}
            tab={tab}
            pending={pending}
            spent={spent}
            set={setDraft}
            setTab={setTab}
            run={run}
            pressRef={pressRef}
          />
        }
        body={
          <div aria-busy={pending} className="resp-pane">
            {error ? (
              <p className="run-err" role="alert">
                {error}
              </p>
            ) : null}
            {pending && !outcome ? <ResponseEmpty pending /> : null}
            {outcome ? (
              <Inspector
                outcome={outcome.result}
                sent={buildSent(op, outcome.draft, origin)}
                codes={codes}
                onReplay={replay}
              />
            ) : pending || error ? null : (
              <ResponseEmpty />
            )}
          </div>
        }
      />
    </div>
  );
}
