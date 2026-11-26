import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { opUrl, PATHS } from '../../../../shared/developers.ts';
import { Ticket } from '../../ui/ticket.tsx';
import { loadFile, loadIndex } from '../data.ts';
import { type Prefill, parseHash } from '../prefill.ts';
import type { Sandbox, Session } from '../session.ts';
import { retain } from '../token.ts';
import type { RunIndex, RunIndexItem, RunOp } from '../types.ts';
import { OpConsole } from './console.tsx';
import { CreateSandbox } from './create-sandbox.tsx';
import { Picker } from './picker.tsx';

export interface RunAppProps {
  session: Exclude<Session, { kind: 'out' }>;
  mode: 'op' | 'console' | 'sheet';
  slug?: string | undefined;
  opId?: string | undefined;
}

type Loaded = { op: RunOp; origin: string } | 'missing' | null;

function useOp(slug: string | undefined, id: string | undefined): Loaded {
  const [state, setState] = useState<Loaded>(null);
  useEffect(() => {
    setState(null);
    if (!slug || !id) return;
    let live = true;
    loadFile(slug).then(
      (f) => {
        const op = f.ops.find((o) => o.id === id);
        if (live) setState(op ? { op, origin: f.origin } : 'missing');
      },
      () => live && setState('missing'),
    );
    return () => {
      live = false;
    };
  }, [slug, id]);
  return state;
}

function Notice({
  title,
  line,
  href,
  action,
}: {
  title: string;
  line: string;
  href?: string;
  action?: string;
}) {
  return (
    <Ticket
      stub={
        <div className="start">
          <h3 className="h2">{title}</h3>
          <p className="muted sm">{line}</p>
          {href ? (
            <a className="btn" href={href}>
              {action}
            </a>
          ) : null}
        </div>
      }
      body={<p className="muted sm resp-hint">Nothing was sent.</p>}
    />
  );
}

function Ready({
  sandbox,
  csrf,
  mode,
  slug,
  opId,
  codes,
  prefill,
}: {
  sandbox: Sandbox;
  csrf: string;
  mode: RunAppProps['mode'];
  slug?: string | undefined;
  opId?: string | undefined;
  codes: ReadonlySet<string>;
  prefill?: Prefill | undefined;
}) {
  const loaded = useOp(slug, opId);
  useEffect(() => retain(csrf), [csrf]);
  if (loaded === 'missing')
    return <Notice title="Could not load this operation" line="Reload the page and try again." />;
  if (!loaded) return <Notice title="Loading" line="Getting the request ready." />;
  return (
    <OpConsole
      key={loaded.op.id}
      op={loaded.op}
      origin={loaded.origin}
      csrf={csrf}
      templateId={sandbox.templateId}
      codes={codes}
      mode={mode}
      prefill={prefill ?? undefined}
    />
  );
}

function fromHash(index: RunIndex): { item: RunIndexItem | null; prefill: Prefill | null } {
  const { id, prefill } = parseHash(location.hash);
  for (const g of index.groups)
    for (const i of g.items) if (i.id === id) return { item: i, prefill };
  return { item: safeStart(index), prefill: null };
}

/** With no link to one, the console opens on a read: the first GET in reference order, never a write. */
export function safeStart(index: RunIndex): RunIndexItem | null {
  for (const g of index.groups) for (const i of g.items) if (i.method === 'get') return i;
  return null;
}

/** The full-page console: a picker beside the console for the chosen operation. */
function ConsolePage({ sandbox, csrf }: { sandbox: Sandbox; csrf: string }) {
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [item, setItem] = useState<RunIndexItem | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  useEffect(() => {
    void loadIndex().then((i) => {
      const start = fromHash(i);
      setIndex(i);
      setItem(start.item);
      setPrefill(start.prefill);
    });
  }, []);
  const codes = useMemo(() => new Set(index?.codes ?? []), [index]);
  if (!index) return <Notice title="Loading" line="Getting the operations." />;
  return (
    <div className="console-grid">
      <Picker
        index={index}
        current={item?.id ?? null}
        onPick={(i) => {
          setItem(i);
          setPrefill(null);
          history.replaceState(null, '', `#${encodeURIComponent(i.id)}`);
        }}
      />
      <div className="console-main">
        {item ? (
          <>
            <div className="console-op">
              <h2 className="h1">{item.title}</h2>
              <a className="sm" href={opUrl(item.slug, item.anchor)}>
                Read the reference
              </a>
            </div>
            <Ready
              sandbox={sandbox}
              csrf={csrf}
              mode="console"
              slug={item.slug}
              opId={item.id}
              codes={codes}
              prefill={prefill ?? undefined}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// The buddy art is only for the empty and failed cards: its own chunk, so a ready sandbox never loads it.
const StateCard = lazy(() =>
  import('../../ui/state-card.tsx').then((m) => ({ default: m.StateCard })),
);
const Retry = lazy(() => import('../../ui/state-card.tsx').then((m) => ({ default: m.Retry })));

export function RunApp({ session, mode, slug, opId }: RunAppProps) {
  const [codes, setCodes] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void loadIndex().then(
      (i) => setCodes(new Set(i.codes)),
      () => undefined,
    );
  }, []);
  // The check that makes a sandbox runs on the console page alone (its CSP admits the widget).
  if (session.kind === 'none' && mode !== 'console')
    return (
      <Notice
        title="No sandbox yet"
        line="Make one to run this call. It takes a moment."
        href={PATHS.console}
        action="Create sandbox"
      />
    );
  if (session.kind === 'failed')
    return (
      <Suspense fallback={null}>
        <StateCard kind="error" title="Your sandbox did not load">
          <Retry onClick={() => location.reload()} />
        </StateCard>
      </Suspense>
    );
  if (session.kind === 'none')
    return (
      <Suspense fallback={null}>
        <StateCard kind="empty" title="No sandbox yet">
          <CreateSandbox
            csrf={session.csrf}
            siteKey={session.siteKey}
            onReady={() => {
              // A fresh document: the Turnstile script does not stay beside the tokens.
              location.reload();
            }}
          />
        </StateCard>
      </Suspense>
    );
  if (session.kind === 'closed')
    return (
      <Notice
        title="Your sandbox is closed"
        line="Closed sandboxes are read-only and are not made again."
      />
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
