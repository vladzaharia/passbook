import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BENCH_COPY } from '../../../../shared/copy/developers-bench.ts';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { copyWithFeedback } from '../../../developers/shell/copy.ts';
import { Ticket } from '../../../developers/ui/ticket.tsx';
import { consoleRunConfirm } from '../../../lib/confirms-console.ts';
import { useMediaQuery } from '../../../lib/media.ts';
import { useBenchKeys } from '../../bench/keys.ts';
import { BenchSkeleton } from '../../bench/skeleton.tsx';
import { remaining, subscribe } from '../budget.ts';
import { type Moment, momentOf } from '../cheer.ts';
import type { ConsoleClient } from '../client.ts';
import { linesFor } from '../lines.ts';
import { applyPrefill, type Prefill } from '../prefill.ts';
import {
  buildSent,
  type Draft,
  type InputCheck,
  initialDraft,
  problems,
  takesTemplate,
  target,
} from '../request.ts';
import { type Outcome, RunError, send } from '../send.ts';
import { loadTemplateInput } from '../template-sample.ts';
import type { Json, RunOp } from '../types.ts';
import { Builder, type Tab } from './builder.tsx';
import { LazyStage } from './lazy-state.tsx';
import { RunBar } from './run-bar.tsx';

/** Below the bench's 720 px the Run bar docks to the screen's bottom edge. */
const DOCK = '(max-width: 719.98px)';

// The response (its code block, id chips and Trace) is read when there is one to draw, and warmed once the console is idle.
// The dialog (and the Radix it brings) loads when a destructive call is first asked about.
const ConfirmDialog = lazy(() =>
  import('../../../ui/alert-dialog.tsx').then((m) => ({ default: m.ConfirmDialog })),
);
const Cheer = lazy(() => import('./cheer.tsx').then((m) => ({ default: m.Cheer })));
const loadResponse = () => import('./response.tsx');
const ResponseView = lazy(() => loadResponse().then((m) => ({ default: m.ResponseView })));

export interface ConsoleProps {
  op: RunOp;
  origin: string;
  client: ConsoleClient;
  templateId: string | null;
  codes: ReadonlySet<string>;
  /** On the console page the stub grows with its content; on an operation page it is a fixed size. */
  mode: 'op' | 'console' | 'sheet';
  /** A guide's link: the request to start from. */
  prefill?: Prefill | undefined;
  /** Where the request came from, over the form. */
  note?: string | null | undefined;
  /** Why this operation cannot run here: Run is disabled with this line, and Copy as still works. */
  reason?: string | null | undefined;
}

const firstTab = (op: RunOp): Tab =>
  op.params.some((p) => p.where !== 'header') || !op.body ? 'form' : 'json';

/** One operation: the request as the ticket stub, the response as its body. Remounted per operation. */
export function OpConsole({
  op,
  origin,
  client,
  templateId,
  codes,
  mode,
  prefill,
  note,
  reason,
}: ConsoleProps) {
  const [draft, setDraft] = useState<Draft>(() => {
    const start = initialDraft(op, templateId);
    return prefill ? applyPrefill(start, op, prefill, templateId) : start;
  });
  const [check, setCheck] = useState<InputCheck | undefined>();
  const untouched = useRef(draft.body);
  const guided = prefill?.body !== undefined;
  // The template is read on first need (a Run or an edit), unless a token is already held: opening a page mints none.
  const [asked, setAsked] = useState(client.eager);
  const [tab, setTab] = useState<Tab>(() => firstTab(op));
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ result: Outcome; draft: Draft; at: number } | null>(
    null,
  );
  const count = useRef(0);
  const [moment, setMoment] = useState<{ at: number; moment: Moment } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spent, setSpent] = useState(() => remaining() === 0);
  const live = useRef(true);
  const pressRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const warm = setTimeout(
      () => void loadResponse().catch((error: unknown) => reportError(error)),
      1500,
    );
    return () => clearTimeout(warm);
  }, []);

  useEffect(() => {
    live.current = true;
    const off = subscribe(() => setSpent(remaining() === 0));
    return () => {
      live.current = false;
      off();
    };
  }, []);

  // The template's own sample replaces the example's `input`, unless a guide link or the reader wrote the body.
  useEffect(() => {
    if (!asked || !templateId || !takesTemplate(op)) return;
    let on = true;
    void loadTemplateInput(templateId, client.send).then((tpl) => {
      if (!on) return;
      if (tpl.schema) setCheck({ templateId, schema: tpl.schema });
      const sample: Json | undefined = tpl.sample;
      if (sample === undefined || guided) return;
      const body = initialDraft(op, templateId, sample).body;
      const before = untouched.current;
      untouched.current = body;
      setDraft((cur) => (cur.body === before ? { ...cur, body } : cur));
    });
    return () => {
      on = false;
    };
  }, [op, templateId, client, guided, asked]);

  const execute = useCallback(
    async (d: Draft, again: boolean) => {
      setPending(true);
      setError(null);
      try {
        const result = await send(op, d, client.send);
        if (!live.current) return;
        count.current += 1;
        setOutcome({ result, draft: d, at: count.current });
        const moment = mode === 'console' ? momentOf(op, result) : null;
        setMoment(moment ? { at: count.current, moment } : null);
        // A call that went through spends its key: the next Run is a new call. "Same key" keeps it.
        if (!again && d.idemOn && result.status < 500)
          setDraft((cur) => ({ ...cur, idemKey: crypto.randomUUID() }));
      } catch (e) {
        if (live.current) setError(e instanceof RunError ? e.message : CONSOLE_COPY.runFailed);
      } finally {
        if (live.current) setPending(false);
      }
    },
    [op, client, mode],
  );

  const edit = (next: Draft) => {
    setAsked(true);
    setDraft(next);
  };
  const run = () => {
    setAsked(true);
    void execute(draft, false);
  };
  const replay = outcome ? () => void execute(outcome.draft, true) : undefined;
  const issues = problems(op, draft, check);

  // On the Workbench the Run bar docks to the bottom of a phone; elsewhere it ends the request.
  const phone = useMediaQuery(DOCK);
  const docked = mode === 'console' && phone;
  const bar = (
    <RunBar
      op={op}
      draft={draft}
      check={check}
      issues={issues}
      pending={pending}
      spent={spent}
      run={run}
      pressRef={pressRef}
      reason={reason}
      ask={mode === 'console' ? () => setConfirming(true) : undefined}
    />
  );
  // The bench's keys reach the console from the list too (a focused field has its own Cmd+Enter below).
  useBenchKeys(
    mode === 'console'
      ? {
          primary: () => pressRef.current?.(),
          copyCurl: () =>
            void copyWithFeedback(
              linesFor(op, draft, origin).find((l) => l.lang === 'curl')?.code ?? '',
              null,
            ),
          ...(outcome?.result.requestId
            ? { copyId: () => void copyWithFeedback(outcome.result.requestId ?? '', null) }
            : {}),
        }
      : {},
  );

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
          <>
            {note ? <p className="console-note">{note}</p> : null}
            <Builder
              op={op}
              origin={origin}
              draft={draft}
              check={check}
              tab={tab}
              set={edit}
              setTab={setTab}
            />
            {docked ? null : bar}
          </>
        }
        body={
          <div aria-busy={pending} className="resp-pane">
            {error ? (
              <p className="run-err" role="alert">
                {error}
              </p>
            ) : null}
            {pending && !outcome ? <BenchSkeleton rows={3} /> : null}
            {outcome && moment?.at === outcome.at ? (
              <Suspense fallback={null}>
                <Cheer kind={moment.moment.kind} />
              </Suspense>
            ) : null}
            {outcome ? (
              <Suspense fallback={<BenchSkeleton rows={3} />}>
                <ResponseView
                  outcome={outcome.result}
                  at={outcome.at}
                  sent={buildSent(op, outcome.draft, origin)}
                  codes={codes}
                  client={client}
                  lines={linesFor(op, outcome.draft, origin)}
                  caption={moment?.at === outcome.at ? moment.moment.caption : null}
                  onReplay={replay}
                />
              </Suspense>
            ) : pending || error ? null : (
              <LazyStage scene="nudge" mood="curious" title={BENCH_COPY.state.consoleIdle} />
            )}
          </div>
        }
      />
      {docked ? <div className="runbar-dock">{bar}</div> : null}
      {mode === 'console' && confirming ? (
        <Suspense fallback={null}>
          <ConfirmDialog
            open
            onOpenChange={setConfirming}
            destructive
            {...consoleRunConfirm(op.method.toUpperCase(), target(op, draft))}
            onConfirm={run}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
