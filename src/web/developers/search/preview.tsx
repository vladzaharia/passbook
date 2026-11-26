import { CornerDownLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SEARCH_COPY } from '../../../shared/copy/developers-search.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchTime } from '../bench/time.tsx';
import { statusText } from '../ui/status-text.ts';
import { type Activity, codeActivity } from './net.ts';
import type { SearchIndex } from './types.ts';

const P = SEARCH_COPY.preview;

function Actions({ href, second }: { href: string; second?: { label: string; href: string } }) {
  return (
    <div className="srch-actions">
      <a className="btn sm" href={href}>
        {P.open}
        <CornerDownLeft aria-hidden />
      </a>
      {second ? (
        <a className="btn outline sm" href={second.href}>
          {second.label}
        </a>
      ) : null}
    </div>
  );
}

/** How often the code showed in the sandbox's log; fetched when the row is picked, not while arrowing past it. */
function useActivity(code: string | null): Activity | null {
  const [seen, setSeen] = useState<{ code: string; activity: Activity | null } | null>(null);
  useEffect(() => {
    if (!code) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void codeActivity(code, abort.signal).then((activity) => setSeen({ code, activity }));
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [code]);
  return seen?.code === code ? seen.activity : null;
}

function ErrorPane({ code, index }: { code: string; index: SearchIndex }) {
  const e = index.errors.find((x) => x.code === code);
  const activity = useActivity(code);
  if (!e) return null;
  return (
    <div className="srch-pv">
      {e.status ? <span className="pill danger">{statusText(e.status)}</span> : null}
      <div className="srch-pvh mono">{e.code}</div>
      <p className="sm">{e.when || e.title}</p>
      {e.fix ? (
        <>
          <div className="xs muted">{P.fix}</div>
          <p className="sm">{e.fix}</p>
        </>
      ) : null}
      {activity ? (
        <>
          <div className="xs muted">{P.inLog}</div>
          <p className="sm">
            {activity.count === 0 ? (
              P.none
            ) : (
              <>
                <span className="strong">
                  {activity.count}
                  {activity.more ? '+' : ''}
                </span>{' '}
                in the last 24 h
                {activity.lastAt ? (
                  <>
                    , last at <BenchTime at={activity.lastAt} />
                  </>
                ) : null}
              </>
            )}
          </p>
        </>
      ) : null}
      <Actions href={e.href} second={{ label: P.log, href: `${PATHS.logs}?code=${e.code}` }} />
    </div>
  );
}

function OpPane({ id, index }: { id: string; index: SearchIndex }) {
  const o = index.ops.find((x) => x.id === id);
  if (!o) return null;
  return (
    <div className="srch-pv">
      <div className="srch-pvh mono">
        {o.method} {o.path}
      </div>
      <p className="sm strong">{o.title}</p>
      {o.desc ? <p className="sm">{o.desc}</p> : null}
      <div className="xs muted">{P.sdk}</div>
      <code className="mono sm">{o.sdk}</code>
      {o.scopes.length > 0 ? (
        <>
          <div className="xs muted">{P.scopes}</div>
          <p className="sm mono">{o.scopes.join(', ')}</p>
        </>
      ) : null}
      {o.idempotent ? <span className="pill neutral">{P.idempotent}</span> : null}
      <Actions href={o.href} second={{ label: P.builder, href: `${PATHS.console}#${o.id}` }} />
    </div>
  );
}

function Plain({
  title,
  mono,
  line,
  href,
}: {
  title: string;
  mono?: boolean;
  line: string;
  href: string;
}) {
  return (
    <div className="srch-pv">
      <div className={mono ? 'srch-pvh mono' : 'srch-pvh'}>{title}</div>
      <p className="sm">{line}</p>
      <Actions href={href} />
    </div>
  );
}

/** The pane beside the list: what the picked row is, and where Enter takes you. */
export function Preview({ id, index }: { id: string; index: SearchIndex }) {
  const at = id.indexOf(':');
  const kind = id.slice(0, at);
  const key = id.slice(at + 1);
  if (kind === 'error') return <ErrorPane code={key} index={index} />;
  if (kind === 'op') return <OpPane id={key} index={index} />;
  if (kind === 'guide') {
    const g = index.guides.find((x) => x.id === key);
    return g ? <Plain title={g.title} line={g.line} href={g.href} /> : null;
  }
  if (kind === 'event') {
    const e = index.events.find((x) => x.type === key);
    return e ? <Plain title={e.type} mono line={e.summary} href={e.href} /> : null;
  }
  if (kind === 'action') {
    const a = index.actions.find((x) => x.id === key);
    return a ? (
      <Plain
        title={a.label}
        line={a.sandbox ? `${a.line}. ${SEARCH_COPY.hints.sandbox}.` : a.line}
        href={a.href}
      />
    ) : null;
  }
  return null;
}
