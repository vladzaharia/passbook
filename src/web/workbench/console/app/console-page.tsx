import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { opUrl } from '../../../../shared/developers.ts';
import { MethodPill } from '../../../developers/ui/method-pill.tsx';
import { useMediaQuery } from '../../../lib/media.ts';
import { BenchSkeleton } from '../../bench/skeleton.tsx';
import { BenchSlot } from '../../bench/slots.tsx';
import { BENCH_WIDE, BenchSplit } from '../../bench/split.tsx';
import { SearchField, Toolbar } from '../../bench/toolbar.tsx';
import { useBenchSelection } from '../../bench/use-selection.ts';
import { loadIndex } from '../data.ts';
import { type Prefill, parseHash } from '../prefill.ts';
import type { Sandbox } from '../session.ts';
import type { RunIndex } from '../types.ts';
import { type IndexOp, idOfOp, OpIndex } from './index-pane.tsx';
import { LazyState } from './lazy-state.tsx';
import { Ready } from './ready.tsx';

const C = CONSOLE_COPY;

/** With no link to one, the console opens on a read: the first GET in reference order, never a write. */
export function safeStart(index: RunIndex): IndexOp | null {
  for (const g of index.groups)
    for (const i of g.items) if (i.method === 'get') return { ...i, group: g.label };
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
 * "Operation" trigger), the request and its response as the stage. The address is `#<operationId>`,
 * with a guide's `?body=` and `?q.<name>=` after it.
 */
export function ConsolePage({ sandbox, csrf }: { sandbox: Sandbox; csrf: string }) {
  const [index, setIndex] = useState<RunIndex | 'failed' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [indexOpen, setIndexOpen] = useState(false);
  const [guide, setGuide] = useState<{ id: string; prefill: Prefill } | null>(() =>
    location.hash.includes('?') ? parseHash(location.hash) : null,
  );
  const wide = useMediaQuery(BENCH_WIDE);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry button's re-read.
  useEffect(() => {
    loadIndex().then(setIndex, (error: unknown) => {
      reportError(error);
      setIndex('failed');
    });
  }, [attempt]);
  useEffect(() => {
    const follow = () => setGuide(location.hash.includes('?') ? parseHash(location.hash) : null);
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);

  const all = useMemo(() => (index && index !== 'failed' ? flatten(index) : []), [index]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? all.filter((o) => matches(o, needle)) : all),
    [all, needle],
  );
  const codes = useMemo(() => new Set(index && index !== 'failed' ? index.codes : []), [index]);
  const selection = useBenchSelection({ items: shown, idOf: idOfOp });
  const current = useMemo(
    () => all.find((o) => o.id === selection.selectedId) ?? null,
    [all, selection.selectedId],
  );

  // No (known) operation in the address: open on the first read, and say so in the address.
  const { select } = selection;
  useEffect(() => {
    if (!index || index === 'failed' || current) return;
    const start = safeStart(index);
    if (start) select(start.id, { open: false });
  }, [index, current, select]);

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

  if (index === 'failed')
    return <LazyState scene="failed" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!index) return <BenchSkeleton rows={8} />;

  const prefill = guide && current && guide.id === current.id ? guide.prefill : null;
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
            <a className="sm console-ref" href={opUrl(current.slug, current.anchor)}>
              {C.reference}
            </a>
          </>
        ) : null}
      </div>
      {current ? (
        <Ready
          sandbox={sandbox}
          csrf={csrf}
          mode="console"
          slug={current.slug}
          opId={current.id}
          codes={codes}
          prefill={prefill ?? undefined}
        />
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
        pane={<OpIndex items={shown} selection={pick} query={query} onClear={clear} />}
      />
    </>
  );
}
