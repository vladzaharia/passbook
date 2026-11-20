import { useEffect, useMemo, useState } from 'react';
import { PATHS } from '../../../../shared/developers.ts';
import { Ticket } from '../../ui/ticket.tsx';
import { loadFile, loadIndex } from '../data.ts';
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
}: {
  sandbox: Sandbox;
  csrf: string;
  mode: RunAppProps['mode'];
  slug?: string | undefined;
  opId?: string | undefined;
  codes: ReadonlySet<string>;
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
    />
  );
}

function fromHash(index: RunIndex): RunIndexItem | null {
  let id = '';
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A malformed escape in the hash: start from the first operation.
  }
  for (const g of index.groups) for (const i of g.items) if (i.id === id) return i;
  return index.groups[0]?.items[0] ?? null;
}

/** The full-page console: a picker beside the console for the chosen operation. */
function ConsolePage({ sandbox, csrf }: { sandbox: Sandbox; csrf: string }) {
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [item, setItem] = useState<RunIndexItem | null>(null);
  useEffect(() => {
    void loadIndex().then((i) => {
      setIndex(i);
      setItem(fromHash(i));
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
          history.replaceState(null, '', `#${encodeURIComponent(i.id)}`);
        }}
      />
      <div className="console-main">
        {item ? (
          <>
            <div className="console-op">
              <h2 className="h1">{item.title}</h2>
              <a className="sm" href={`/developers/reference/${item.slug}#${item.anchor}`}>
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
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

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
  if (session.kind === 'none')
    return (
      <Ticket
        stub={
          <CreateSandbox
            csrf={session.csrf}
            siteKey={session.siteKey}
            onReady={() => {
              // A fresh document: the Turnstile script does not stay beside the tokens.
              location.reload();
            }}
          />
        }
        body={<p className="muted sm resp-hint">Runs against your sandbox. Nothing is issued.</p>}
      />
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
