import { useLocation, useRouter } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { opUrl } from '../../../../shared/developers.ts';
import { MethodPill } from '../../../developers/ui/method-pill.tsx';
import { useMediaQuery } from '../../../lib/media.ts';
import { BenchSkeleton } from '../../bench/skeleton.tsx';
import { BenchSlot } from '../../bench/slots.tsx';
import { BENCH_WIDE, BenchSplit } from '../../bench/split.tsx';
import { SearchField, Toolbar } from '../../bench/toolbar.tsx';
import { bindBenchRouter } from '../../bench/url.ts';
import { useWorkbenchContexts } from '../../host/contexts.ts';
import { useConsoleClient } from '../client.ts';
import { loadIndex } from '../data.ts';
import { launchOf, shimHash } from '../launch.ts';
import type { RunIndex } from '../types.ts';
import { type IndexOp, OpIndex } from './index-pane.tsx';
import { LazyState } from './lazy-state.tsx';
import { Ready } from './ready.tsx';
import { useLogRead } from './use-launch.ts';
import { useOpSelection } from './use-op-selection.ts';

const C = CONSOLE_COPY;

/**
 * With no link to one, the console opens on a read: the first GET in reference order, never a
 * write, and one this context may run (`allowed`).
 */
export function safeStart(index: RunIndex, allowed: (op: { wb: boolean }) => boolean = () => true) {
  for (const g of index.groups)
    for (const i of g.items) if (i.method === 'get' && allowed(i)) return { ...i, group: g.label };
  return null;
}

const flatten = (index: RunIndex): IndexOp[] =>
  index.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

const matches = (op: IndexOp, q: string) =>
  `${op.title} ${op.path} ${op.method}`.toLowerCase().includes(q);

/** The operation's path without the API prefix, as the reference writes it. */
const shortPath = (path: string) => path.replace(/^\/api\/v1/, '');

/**
 * The Console tool: the operation index in the bench's pane (a sheet below 1180 px, opened by the
 * "Operation" trigger), the request and its response as the stage. It runs on the org's Workbench
 * token. The address is `?op=<operationId>` with one source of a request: `sample=` (a guide's
 * snippet), `from=` (a Logs row) or `prefill=` (another tool's handoff). It never runs on arrival.
 */
export function ConsolePage() {
  const router = useRouter();
  const client = useConsoleClient();
  const orgId = client?.orgId;
  const contexts = useWorkbenchContexts();
  const context = contexts.data?.find((c) => c.orgId === orgId) ?? null;
  const search = useLocation({ select: (l) => l.searchStr });
  const hash = useLocation({ select: (l) => l.hash });
  const pathname = useLocation({ select: (l) => l.pathname });
  const [index, setIndex] = useState<RunIndex | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [indexOpen, setIndexOpen] = useState(false);
  const wide = useMediaQuery(BENCH_WIDE);

  useEffect(() => {
    bindBenchRouter((href) => router.history.replace(href));
    return () => bindBenchRouter(null);
  }, [router]);
  // An old `#<op>?body=` link: the body moves out of the address into a handoff.
  useEffect(() => {
    const next = shimHash(hash ? `#${hash}` : '', search);
    if (next) router.history.replace(`${pathname}${next}`);
  }, [hash, search, pathname, router]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry button's re-read.
  useEffect(() => {
    loadIndex().then(setIndex, (error: unknown) => {
      reportError(error);
      setIndex('failed');
    });
  }, [attempt]);

  // A member's Test may call the allowlisted operations only; the server holds the line, this says why.
  const lockedHere = useCallback(
    (op: { wb: boolean }) => context?.kind === 'org' && !op.wb,
    [context],
  );
  const launch = useMemo(() => launchOf(search), [search]);
  const all = useMemo(() => (index && index !== 'failed' ? flatten(index) : []), [index]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? all.filter((o) => matches(o, needle)) : all),
    [all, needle],
  );
  const codes = useMemo(() => new Set(index && index !== 'failed' ? index.codes : []), [index]);
  const log = useLogRead(client, launch.from, all);
  // A Logs row names its operation by what it called when the link did not.
  const opId = launch.op ?? (log.state === 'ready' ? log.opId : null);
  const selection = useOpSelection(all, shown, opId);
  const current = selection.selected;
  const { select } = selection;

  // No (known) operation in the address: open on the first read, and say so in the address.
  useEffect(() => {
    if (!index || index === 'failed' || current || launch.from) return;
    // Wait for the context: a member's Test runs the allowlisted operations only.
    if (client && contexts.isPending) return;
    const start = safeStart(index, (op) => !lockedHere(op));
    if (start) select(start.id, { open: false });
  }, [index, current, select, launch.from, client, contexts.isPending, lockedHere]);

  // Beside the stage the index opens on the operation the link named, centred in its own pane. The list's
  // own scroll-into-view also moves the page; the page goes back to where it was.
  const pageTop = useRef(typeof window === 'undefined' ? 0 : window.scrollY);
  const centered = useRef(false);
  const inUse = current?.id;
  useEffect(() => {
    // Below 1180 px the index is a sheet, drawn only when opened: nothing to centre.
    if (!wide || !inUse || centered.current) return;
    let frame = 0;
    let tries = 0;
    const settle = () => {
      const row = document.querySelector('.console-idx [aria-selected="true"]');
      const pane = row?.closest('.bench-pane');
      // The list draws a frame after the stage: look again a few times before giving up.
      if (!(row && pane) && tries++ < 10) {
        frame = requestAnimationFrame(settle);
        return;
      }
      centered.current = true;
      if (row && pane)
        pane.scrollTop +=
          row.getBoundingClientRect().top -
          pane.getBoundingClientRect().top -
          (pane.clientHeight - row.clientHeight) / 2;
      window.scrollTo({ top: pageTop.current });
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [inUse, wide]);

  // The sheet opens on the operation in use, not at the top of 269.
  useEffect(() => {
    if (!indexOpen) return;
    const frame = requestAnimationFrame(() =>
      document
        .querySelector('dialog.bench-sheet [aria-selected="true"]')
        ?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [indexOpen]);

  const pick = useMemo(
    () => ({
      ...selection,
      select: (id: string | null, opts?: { open?: boolean }) => {
        selection.select(id, opts);
        // A pick in the sheet is a choice: it closes.
        if (opts?.open) setIndexOpen(false);
      },
    }),
    [selection],
  );
  const clear = useCallback(() => setQuery(''), []);

  const reasonFor = (op: IndexOp): string | null =>
    !client || !context
      ? C.reason.noSandbox
      : context.closed
        ? C.reason.closed
        : lockedHere(op)
          ? `${C.reason.testOnly}. ${C.reason.testOnlyWhy}`
          : null;

  if (index === 'failed')
    return <LazyState scene="failed" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!index) return <BenchSkeleton rows={8} />;

  const stage = (
    <div className="console-stage">
      <div className="console-op">
        <h2 className="h2 console-op-t" title={wide ? current?.title : undefined}>
          {wide ? (
            current?.title
          ) : (
            <button
              type="button"
              className="btn outline console-trigger"
              aria-haspopup="dialog"
              onClick={() => setIndexOpen(true)}
            >
              <span className="console-trigger-l">{C.trigger}</span>
              {current ? <MethodPill method={current.method} /> : null}
              <span className="console-trigger-t">{current?.title}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          )}
        </h2>
        {current ? (
          <>
            <span className="console-path mono">
              <b>{current.method.toUpperCase()}</b> {shortPath(current.path)}
            </span>
            <a
              className="sm console-ref"
              href={`${opUrl(current.slug, current.anchor)}?from=workbench`}
            >
              {C.reference}
            </a>
          </>
        ) : null}
      </div>
      {current ? (
        client ? (
          <Ready
            key={`${current.id}|${launch.sample}|${launch.from}|${launch.prefill}`}
            client={client}
            mode="console"
            slug={current.slug}
            opId={current.id}
            codes={codes}
            launch={launch}
            log={log}
            reason={reasonFor(current)}
          />
        ) : null
      ) : null}
    </div>
  );
  return (
    <>
      <BenchSlot name="count">{C.count(all.length)}</BenchSlot>
      <Toolbar label={C.find}>
        {/* Below 1180 px the index is a sheet: Enter in the search opens it on the matches. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter is the field's own key; this only listens */}
        <div
          className="console-find"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !wide && needle) setIndexOpen(true);
          }}
        >
          <SearchField label={C.find} value={query} onChange={setQuery} />
        </div>
      </Toolbar>
      <BenchSplit
        layout="index"
        label={C.index}
        open={indexOpen}
        onClose={() => setIndexOpen(false)}
        main={stage}
        pane={
          <OpIndex
            items={shown}
            selection={pick}
            query={query}
            onClear={clear}
            locked={context ? lockedHere : undefined}
          />
        }
      />
    </>
  );
}
