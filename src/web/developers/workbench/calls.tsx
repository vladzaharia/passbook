import { MonitorPlay, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { SOURCES, type Source } from './model.ts';

const methodClass = (m: string) => `method ${m === 'DELETE' ? 'del' : m.toLowerCase()}`;

function CallRow({ call, now, logs }: { call: RequestLogEntry; now: number; logs: string }) {
  const fromKey = call.via === null;
  return (
    <a className="lrow wb-call" href={`${logs}#${call.id}`}>
      <span className={methodClass(call.method)}>{call.method}</span>
      <code className="wb-call-path">{call.route ?? call.path}</code>
      <StatusChip status={call.status} />
      <span className="xs muted mono wb-call-ms">{call.durationMs} ms</span>
      <span className="wb-src" title={fromKey ? 'Your key' : 'Run here'}>
        {fromKey ? <Terminal aria-hidden /> : <MonitorPlay aria-hidden />}
        <span className="sr">{fromKey ? 'Your key' : 'Run here'}</span>
      </span>
      <span className="xs muted mono wb-call-at">
        <BenchTime at={call.at} now={now} />
      </span>
    </a>
  );
}

/**
 * The latest calls with a source filter. `All` is the home's own list; the others ask the log once each, so a
 * filter never shows fewer rows than exist.
 */
export function Calls({
  calls,
  now,
  logs,
  load,
}: {
  calls: RequestLogEntry[];
  now: number;
  logs: string;
  load: (source: Source) => Promise<RequestLogEntry[]>;
}) {
  const [source, setSource] = useState<Source>('all');
  const [rows, setRows] = useState<Partial<Record<Source, RequestLogEntry[]>>>({ all: calls });
  const [failed, setFailed] = useState(false);
  // A new home (after a reset or reopen) replaces what was read before, for every source.
  const seen = useRef(calls);
  useEffect(() => {
    if (seen.current === calls) return;
    seen.current = calls;
    setFailed(false);
    setRows({ all: calls });
    if (source !== 'all')
      load(source).then(
        (items) => setRows((r) => ({ ...r, [source]: items })),
        () => setFailed(true),
      );
  }, [calls, source, load]);
  const pick = (next: Source) => {
    setSource(next);
    setFailed(false);
    if (rows[next]) return;
    load(next).then(
      (items) => setRows((r) => ({ ...r, [next]: items })),
      () => setFailed(true),
    );
  };
  const shown = rows[source];
  return (
    <section className="card wb-calls" aria-labelledby="wb-calls-h">
      <div className="card-h">
        <h2 id="wb-calls-h" className="h3">
          Calls
        </h2>
        <fieldset className="seg wb-seg">
          <legend className="sr">Source</legend>
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={s.id === source}
              data-on={s.id === source ? '' : undefined}
              onClick={() => pick(s.id)}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
        <a className="xs wb-more" href={logs}>
          Logs
        </a>
      </div>
      {failed ? (
        <p className="card-b sm muted">Calls did not load. Pick the filter again.</p>
      ) : !shown ? (
        <p className="card-b sm muted" aria-busy>
          Loading…
        </p>
      ) : shown.length === 0 ? (
        <p className="card-b sm muted">No calls yet.</p>
      ) : (
        <div className="list">
          {shown.map((c) => (
            <CallRow key={c.id} call={c} now={now} logs={logs} />
          ))}
        </div>
      )}
    </section>
  );
}
