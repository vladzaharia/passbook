import { useEffect, useState } from 'react';
import type { DeliveryDetailDto, DeliveryDto, TestAttemptDto, TesterApi } from './client.ts';
import { ago, prettyBody } from './format.ts';

export interface UrlRow {
  key: string;
  at: number;
  status: number | null;
  type: string;
  meta: string;
  test: boolean;
  eventId: string | null;
}

/** Deliveries and test sends of one endpoint as a single list, newest first. */
export function rowsOf(deliveries: DeliveryDto[], tests: TestAttemptDto[]): UrlRow[] {
  const d: UrlRow[] = deliveries.map((x) => ({
    key: x.eventId,
    at: x.lastAttemptAt ?? x.nextAt,
    status: x.lastStatus,
    type: x.type,
    meta: [x.state, x.lastError, x.externalId].filter(Boolean).join(' · '),
    test: false,
    eventId: x.eventId,
  }));
  const t: UrlRow[] = tests.map((x) => ({
    key: x.id,
    at: x.at,
    status: x.status,
    type: 'webhook.test',
    meta: [x.ok ? 'Sent' : 'Failed', x.errorCode, `${x.durationMs} ms`].filter(Boolean).join(' · '),
    test: true,
    eventId: null,
  }));
  return [...d, ...t].sort((a, b) => b.at - a.at);
}

export function UrlEvents({
  rows,
  selected,
  onSelect,
  now,
}: {
  rows: UrlRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  now: number;
}) {
  return (
    <div className="card">
      <div className="card-h">
        <h2 className="h3">Deliveries</h2>
        <span className="xs muted push">Kept 7 days</span>
      </div>
      {rows.length === 0 ? (
        <p className="card-b muted sm" data-empty>
          Nothing sent yet. Send a test event.
        </p>
      ) : (
        <ul className="wh-evs">
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className="wh-ev"
                aria-pressed={r.key === selected}
                onClick={() => onSelect(r.key)}
              >
                <span
                  className={`wh-code ${r.status !== null && r.status < 300 ? 'ok-t' : 'bad-t'}`}
                >
                  {r.status ?? 'err'}
                </span>
                <span className="wh-t">
                  {r.type}
                  {r.test ? <span className="pill neutral wh-tag">Test</span> : null}
                </span>
                <span className="wh-when">{ago(r.at, now)}</span>
                <span className="wh-meta">{r.meta}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A real delivery: its attempts and the payload sent. A test send keeps only its result, so it shows that. */
export function UrlDetail({
  api,
  endpointId,
  row,
}: {
  api: TesterApi;
  endpointId: string;
  row: UrlRow;
}) {
  const [detail, setDetail] = useState<DeliveryDetailDto | null>(null);
  const [failed, setFailed] = useState(false);
  const eventId = row.eventId;
  useEffect(() => {
    setDetail(null);
    setFailed(false);
    if (!eventId) return;
    let live = true;
    api.delivery(endpointId, eventId).then(
      (d) => live && setDetail(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api, endpointId, eventId]);

  return (
    <div className="card">
      <div className="card-h">
        <h2 className="wh-title">{row.type}</h2>
      </div>
      {row.test ? (
        <div className="card-b stack g2">
          <span className="mono sm">{row.status ?? 'No response'}</span>
          <span className="sm muted">{row.meta}</span>
        </div>
      ) : failed ? (
        <p className="card-b muted sm">Could not load this delivery.</p>
      ) : !detail ? (
        <p className="card-b muted sm">Loading.</p>
      ) : (
        <>
          <ul className="wh-evs">
            {detail.attemptLog.map((a) => (
              <li key={`${a.attempt}-${a.at}`} className="wh-att">
                <span
                  className={`wh-code ${a.status !== null && a.status < 300 ? 'ok-t' : 'bad-t'}`}
                >
                  {a.status ?? a.errorCode ?? 'err'}
                </span>
                <span className="sm">
                  Attempt {a.attempt} · {a.trigger}
                </span>
                <span className="xs muted">{a.durationMs} ms</span>
              </li>
            ))}
          </ul>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable text region */}
          <section className="wh-pre" tabIndex={0} aria-label="Payload">
            <pre>{prettyBody(JSON.stringify(detail.payload))}</pre>
          </section>
        </>
      )}
    </div>
  );
}
