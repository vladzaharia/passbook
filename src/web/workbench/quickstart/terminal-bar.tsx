import { CircleAlert, Play, RotateCw, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BuddyArt } from '../../ui/art/buddy-art.tsx';
import { duration } from '../home/model.ts';
import { fixOfCall, maskKey, shortId, stamp } from './model.ts';
import { useQsTransport } from './transport.tsx';
import { useElapsed } from './use-clock.ts';
import { useListener } from './use-listener.ts';
import type { Quickstart } from './use-quickstart.ts';

const T = QS_COPY.call;
const Q = T.quiet;
const isPassCreate = (e: RequestLogEntry) => e.method === 'POST' && e.path.endsWith('/passes');

/** What the sandbox's keys are called on this page: the whole one while it is shown, else the start the server keeps. */
function keyLabel(q: Quickstart): string {
  if (q.secret) return maskKey(q.secret);
  const keys = q.home?.keys ?? [];
  return keys.length === 1 && keys[0] ? `${keys[0].secretPrefix}_…` : '';
}

/** The problem of a call that was answered 4xx: its words, read from the log, and the one line to change. */
function useCallFix(entry: RequestLogEntry | null, q: Quickstart) {
  const [body, setBody] = useState<{
    id: string;
    response: string | null;
    request: string | null;
  } | null>(null);
  const id = entry && entry.status >= 400 ? entry.id : null;
  const { fetch: send } = useQsTransport();
  useEffect(() => {
    if (!id) return;
    let live = true;
    send(`/api/v1/developer/logs/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { responseBody?: string | null; requestBody?: string | null } | null) => {
        if (live)
          setBody({ id, response: d?.responseBody ?? null, request: d?.requestBody ?? null });
      })
      .catch(() => live && setBody({ id, response: null, request: null }));
    return () => {
      live = false;
    };
  }, [id, send]);
  if (!entry || !id) return null;
  const mine = body?.id === id ? body : null;
  return fixOfCall(
    entry,
    { response: mine?.response ?? null, request: mine?.request ?? null },
    q.input,
  );
}

/** After 45 quiet seconds: the buddy and the three usual causes. The art is decoration; the words are the hint. */
function Quiet({ onHere }: { onHere: (() => void) | undefined }) {
  return (
    <section className="qs-quiet" role="status" aria-labelledby="qs-quiet-t">
      <BuddyArt mood="curious" size="sm" still />
      <div className="stack g2">
        <h3 className="h3" id="qs-quiet-t">
          {Q.title}
        </h3>
        <p className="sm muted">{Q.line}</p>
        <ul className="sm qs-quiet-l">
          {Q.causes.map((c) => (
            <li key={c.text}>
              {c.text}
              {'code' in c ? (
                <>
                  {' '}
                  <code className="inline-code">{c.code}</code>. {c.after}
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {onHere ? (
          <button type="button" className="btn sm outline qs-quiet-a" onClick={onHere}>
            {Q.here}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The stamp, who made the call and how long it took. */
export function Stamped({ entry }: { entry: RequestLogEntry }) {
  const ok = entry.status < 400;
  return (
    <div className="row g3 wrap-row qs-heard">
      <span className={`stamp ${ok ? 'ok' : 'bad'}`}>{stamp(entry.status)}</span>
      <span className="chip-from xs">
        {entry.via === 'try' ? (
          <Play aria-hidden="true" className="lucide" />
        ) : (
          <Terminal aria-hidden="true" className="lucide" />
        )}
        {entry.via === 'try' ? T.here : T.from}
      </span>
      <span className="mono xs muted">
        {entry.client ? `${entry.client} · ` : ''}
        {entry.durationMs} ms · req {shortId(entry.requestId)}
      </span>
    </div>
  );
}

/**
 * The page waits for the developer's terminal. While open it listens (a pulse, the key, a clock); a 4xx marks the
 * line to change; a pass made from outside lights the stage; ten quiet minutes end with how to check the key.
 */
export function TerminalBar({
  q,
  active,
  done,
  onHere,
}: {
  q: Quickstart;
  active: boolean;
  done: boolean;
  /** Switches the step to Run here. */
  onHere?: () => void;
}) {
  const cursor = q.home?.calls[0]?.id ?? null;
  const listening = active && q.home !== null;
  const { heard, over, quiet, again } = useListener(listening, cursor, useQsTransport().fetch);
  // After a reload the call is still in the log: the done step shows it as it was.
  const prior = done
    ? (q.home?.calls.find((e) => isPassCreate(e) && e.status < 400) ?? null)
    : null;
  const last = heard.at(-1) ?? prior;
  const since = useRef(Date.now());
  const waiting = useElapsed(since.current, listening && !over && !last, null);
  const fix = useCallFix(last, q);
  const handled = useRef<string | null>(null);
  const { heardPass } = q;
  useEffect(() => {
    const made = [...heard].reverse().find((e) => isPassCreate(e) && e.status < 400);
    if (made && handled.current !== made.id) {
      handled.current = made.id;
      heardPass(made);
    }
  }, [heard, heardPass]);

  const made = last && isPassCreate(last) && last.status < 400;
  const label = keyLabel(q);
  return (
    <>
      <div
        className="runbar qs-runbar qs-term"
        data-state={last ? (last.status < 400 ? 'ok' : 'fail') : 'wait'}
      >
        <div className="qs-run-left" role="status" aria-live="polite">
          {last ? (
            <>
              <Stamped entry={last} />
              {!made && last.status < 400 ? (
                <p className="xs muted qs-note">
                  {T.other(last.method, last.path.replace(/^\/api\/v1/, ''), last.status)}
                </p>
              ) : null}
            </>
          ) : done ? (
            <span className="sm">{T.made}</span>
          ) : over ? (
            <span className="xs muted">
              {T.timeout} <code className="inline-code">{T.timeoutCode}</code>
            </span>
          ) : (
            <span className="row g2 sm">
              <span className="qs-pulse" aria-hidden="true" />
              <span>
                {label ? (
                  <>
                    {T.listening} <b className="mono">{label}</b>
                  </>
                ) : (
                  T.anyKey
                )}
              </span>
              <span className="mono xs muted">{duration(waiting * 1000)}</span>
            </span>
          )}
        </div>
        {over && !last ? (
          <button type="button" className="btn outline" onClick={again}>
            <RotateCw aria-hidden="true" />
            {T.again}
          </button>
        ) : null}
      </div>
      {quiet && !over && !last ? <Quiet onHere={onHere} /> : null}
      {fix ? (
        <section className="qs-fix" role="alert">
          <h3 className="h3 row g2">
            <CircleAlert aria-hidden="true" className="lucide" />
            {fix.title}
          </h3>
          {fix.path ? <p className="mono xs muted">{fix.path}</p> : null}
          {fix.line ? <p className="sm">{fix.line}</p> : null}
          {fix.code ? <a href={`${PATHS.errors}/${fix.code}`}>{fix.code}</a> : null}
        </section>
      ) : null}
    </>
  );
}
