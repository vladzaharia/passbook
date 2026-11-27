import { Repeat } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import { PATHS } from '../../../../shared/developers.ts';
import { wbPath } from '../../../../shared/workbench.ts';
import { Stamp } from '../../../developers/ui/stamp.tsx';
import { statusText } from '../../../developers/ui/status-text.ts';
import { BenchCode } from '../../bench/code-block.tsx';
import { IdChip } from '../../bench/id-chip.tsx';
import { Trace, traceNodes } from '../../bench/trace.tsx';
import { type CausedEvent, loadRequestEvents } from '../../bench/trace-events.ts';
import { RUN_LIMIT, remaining as runsLeft } from '../budget.ts';
import type { ConsoleClient } from '../client.ts';
import type { Sent } from '../copy-as.ts';
import { EVENTS_AFTER_MS, showsSecret } from '../events.ts';
import type { Line } from '../lines.ts';
import type { Outcome } from '../send.ts';
import '../response.css';

const C = CONSOLE_COPY;
const header = (o: Outcome, name: string) => o.headers.find(([n]) => n === name)?.[1];

/** The webhook events one call caused, read once after a write succeeds. A failed read leaves the Trace without them. */
function useCausedEvents(
  o: Outcome,
  method: string,
  client: ConsoleClient,
): readonly CausedEvent[] {
  const [events, setEvents] = useState<readonly CausedEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!o.requestId || method === 'GET' || o.status >= 300) return;
    const rid = o.requestId;
    let on = true;
    const timer = setTimeout(() => {
      loadRequestEvents(rid, client.get).then(
        (found) => on && setEvents(found),
        (error: unknown) => reportError(error),
      );
    }, EVENTS_AFTER_MS);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [o, method, client]);
  return events;
}

/**
 * The response: the stamp, timing and request id, the headers that matter, the body as the bench's
 * code block (ids are chips), and the Trace to Logs and the events the call caused. `at` is the
 * outcome's own count: a new outcome stamps again, a re-render does not.
 */
export function ResponseView({
  outcome: o,
  at,
  sent,
  codes,
  client,
  lines,
  caption,
  onReplay,
}: {
  outcome: Outcome;
  at: number;
  sent: Sent;
  codes: ReadonlySet<string>;
  client: ConsoleClient;
  /** The request in every language, for Copy as. */
  lines: Line[];
  /** The buddy's line: what went wrong, or "Pass issued". */
  caption?: string | null | undefined;
  /** Sends the same request again with the same Idempotency-Key. */
  onReplay?: (() => void) | undefined;
}) {
  const label = statusText(o.status, o.statusText);
  const remaining = header(o, 'ratelimit-remaining');
  const replay = header(o, 'idempotent-replayed');
  const events = useCausedEvents(o, sent.method, client);
  const facts: [string, string][] = [
    // The server sends RateLimit-Remaining on 429 only; otherwise the page's own count is the gauge.
    remaining ? ['RateLimit-Remaining', remaining] : [C.runsLeft, `${runsLeft()}/${RUN_LIMIT}`],
    ...(o.key
      ? [['Idempotent-Replayed', replay === 'true' ? 'true' : 'false'] as [string, string]]
      : []),
    ...(header(o, 'etag') ? [['ETag', header(o, 'etag') as string] as [string, string]] : []),
    ...(header(o, 'retry-after')
      ? [['Retry-After', `${header(o, 'retry-after')} s`] as [string, string]]
      : []),
  ];
  const nodes = useMemo(
    () =>
      traceNodes({
        request: {
          id: o.requestId,
          method: sent.method,
          path: new URL(sent.url, location.origin).pathname.replace(/^\/api\/v1/, ''),
          status: o.status,
        },
        events,
      }),
    [o.requestId, o.status, sent, events],
  );
  return (
    <div className="cr">
      <div className="cr-h">
        <Stamp key={at} status={label} tone={o.status < 400 ? 'ok' : 'bad'} />
        <span className="mono xs muted">{o.ms} ms</span>
        {o.requestId ? <IdChip id={o.requestId} kind="request" prefix="req" /> : null}
        {caption ? (
          <span className="cr-cap" data-kind={o.status < 400 ? 'ok' : 'bad'}>
            {caption}
          </span>
        ) : null}
        <span className="push" />
        {o.requestId ? (
          <a
            className="btn outline sm"
            href={
              client.orgId
                ? wbPath(client.orgId, 'logs', { hash: o.requestId })
                : `${PATHS.logs}?source=all#${encodeURIComponent(o.requestId)}`
            }
          >
            {C.viewInLogs}
          </a>
        ) : null}
      </div>
      <p className="sr" role="status" aria-live="polite">
        {label} in {o.ms} milliseconds.
        {replay === 'true' ? ' Replayed from the first call.' : ''}
      </p>
      <dl className="cr-facts">
        {facts.map(([k, v]) => (
          <div key={k} className={k === 'Idempotent-Replayed' && v === 'true' ? 'fact on' : 'fact'}>
            <dt className="mono">{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      {o.key && o.status < 300 && onReplay ? (
        <button type="button" className="btn ghost sm cr-replay" onClick={onReplay}>
          <Repeat aria-hidden="true" />
          {C.runAgain}
        </button>
      ) : null}
      {showsSecret(o.json) ? <p className="cr-secret xs">{C.secret}</p> : null}
      <div className="cr-body">
        <BenchCode
          label={C.response}
          // The parsed, masked value, never the raw text again: an escape such as \u005f only becomes a token after a parse.
          body={o.json !== undefined ? JSON.stringify(o.json, null, 2) : o.text}
          codes={codes}
          empty={C.noBody}
          items={lines.map((l) => ({ key: l.lang, label: l.label, text: () => l.code }))}
        />
      </div>
      {o.truncated ? <p className="xs muted cr-note">{C.truncated}</p> : null}
      <div className="cr-trace">
        <Trace nodes={nodes} />
      </div>
    </div>
  );
}
