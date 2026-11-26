import { Copy, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import { BenchCode } from '../bench/code-block.tsx';
import { IdChip, shortId } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Trace, type TraceNode } from '../bench/trace.tsx';
import type { DeliveryDetailDto, TesterApi } from './client.ts';
import { curlOf } from './format.ts';
import { type Row, stateWord, toneOfRow } from './model.ts';
import { VERIFY_SAMPLES } from './samples.ts';
import { Samples } from './samples-tabs.tsx';
import { VerifyPanel } from './verify.tsx';

const C = BENCH_WEBHOOKS_COPY;
const I = C.inspector;
const CLI = 'npx @passbook/cli listen --forward-to localhost:3000/hooks';

type TabId = 'headers' | 'body' | 'attempts' | 'verify';
const TABS: Record<Row['kind'], readonly TabId[]> = {
  capture: ['headers', 'body', 'attempts', 'verify'],
  delivery: ['body', 'attempts'],
  test: ['attempts'],
};
const FIRST: Record<Row['kind'], TabId> = { capture: 'verify', delivery: 'body', test: 'attempts' };

/** A URL delivery's attempts and the payload sent, read when it opens. */
function useDelivery(api: TesterApi, row: Row) {
  const [detail, setDetail] = useState<DeliveryDetailDto | null>(null);
  const [failed, setFailed] = useState(false);
  const eventId = row.kind === 'delivery' ? row.eventId : null;
  useEffect(() => {
    setDetail(null);
    setFailed(false);
    if (!eventId) return;
    let live = true;
    api.delivery(row.endpointId, eventId).then(
      (d) => live && setDetail(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api, row.endpointId, eventId]);
  return { detail, failed };
}

function Attempts({ row, detail }: { row: Row; detail: DeliveryDetailDto | null }) {
  if (row.kind === 'capture')
    return (
      <div className="wh-pane">
        <span className="wh-line">
          <StatusChip status={row.status} /> {row.durationMs} ms · {row.meta}
        </span>
        <span className="muted sm">{I.stored}</span>
      </div>
    );
  if (row.kind === 'test')
    return (
      <div className="wh-pane">
        <span className="wh-line">
          {row.status ? <StatusChip status={row.status} /> : null} {row.meta}
        </span>
      </div>
    );
  if (!detail || detail.attemptLog.length === 0)
    return <BenchCode label={C.tabs.attempts} body={null} empty={I.noAttempts} />;
  return (
    <ol className="wh-attempts">
      {detail.attemptLog.map((a) => (
        <li key={`${a.attempt}-${a.at}`}>
          <StatusChip status={a.status} tone={a.status ? undefined : 'danger'}>
            {a.status ?? a.errorCode ?? 'err'}
          </StatusChip>
          <span className="sm">
            {I.trigger[a.trigger]} {a.attempt}
          </span>
          <BenchTime at={a.at} className="muted xs" />
          <span className="xs muted wh-ms">{a.durationMs} ms</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The selected delivery in the bench's one inspector. A capture has its headers, body, attempt and the
 * Verify steps; a URL delivery its payload and attempts; a test send only its result. The Trace
 * ends it: the API request that caused the event opens in Logs.
 */
export function WebhookInspector({
  api,
  row,
  busy,
  loadSecret,
  onReplay,
  onPrev,
  onNext,
}: {
  api: TesterApi;
  row: Row;
  busy: boolean;
  loadSecret: () => Promise<string>;
  onReplay: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const tabs = TABS[row.kind];
  const [tab, setTab] = useState<TabId>(FIRST[row.kind]);
  // The tab stays across rows; a tab this kind of row lacks falls back to its first.
  const shown = tabs.includes(tab) ? tab : FIRST[row.kind];
  const key = `${row.kind}:${row.id}`;
  const { detail, failed } = useDelivery(api, row);
  const requestId =
    row.requestId ??
    (detail && typeof detail.payload.requestId === 'string' ? detail.payload.requestId : null);
  const nodes: TraceNode[] = useMemo(
    () => [
      {
        kind: 'request',
        id: requestId,
        text: requestId ? shortId(requestId) : '',
        prefix: 'request',
      },
      { kind: 'event', id: row.eventId, text: row.type },
    ],
    [requestId, row.eventId, row.type],
  );
  const capture = row.capture;
  const replayable = row.kind === 'capture' || row.kind === 'delivery';

  return (
    <Inspector
      title={row.type}
      label={I.label(row.type)}
      itemKey={key}
      status={
        <StatusChip status={row.status} tone={toneOfRow(row)}>
          {row.status ?? stateWord(row)}
        </StatusChip>
      }
      id={row.eventId ? <IdChip id={row.eventId} kind="event" /> : undefined}
      actions={
        <>
          {replayable ? (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy || detail?.state === 'pending'}
              onClick={onReplay}
            >
              <RotateCw aria-hidden="true" />
              {I.replay}
            </button>
          ) : null}
          {capture ? (
            <button
              type="button"
              className="btn ghost sm"
              data-copy
              data-copy-text={curlOf(capture)}
            >
              {I.curl}
            </button>
          ) : null}
        </>
      }
      facts={
        <>
          <BenchTime at={row.at} mode="full" />
          {row.durationMs !== null ? <span>{row.durationMs} ms</span> : null}
          {row.passId ? <IdChip id={row.passId} kind="pass" prefix="pass" /> : null}
        </>
      }
      tabs={tabs.map((id) => ({ id, label: C.tabs[id] }))}
      tab={shown}
      onTab={(id) => setTab(id as TabId)}
      onPrev={onPrev}
      onNext={onNext}
      trace={requestId ? <Trace nodes={nodes} /> : undefined}
    >
      {shown === 'headers' && capture ? (
        <BenchCode
          label={I.headers}
          lang="cli"
          body={Object.entries(capture.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
          empty={I.noHeaders}
        />
      ) : null}
      {shown === 'body' ? (
        capture ? (
          <BenchCode
            label={I.body}
            body={capture.body}
            items={[{ key: 'curl', label: 'curl', text: () => curlOf(capture) }]}
            empty={I.noBody}
          />
        ) : failed ? (
          <BenchCode label={I.body} body={null} empty={I.failed} />
        ) : detail ? (
          <BenchCode label={I.payload} body={JSON.stringify(detail.payload)} empty={I.noBody} />
        ) : (
          <BenchCode label={I.body} body={null} empty={BENCH_COPY.loading} />
        )
      ) : null}
      {shown === 'attempts' ? <Attempts row={row} detail={detail} /> : null}
      {shown === 'verify' && capture ? (
        <>
          <VerifyPanel key={capture.id} capture={capture} loadSecret={loadSecret} />
          <div className="wh-pane">
            <h3 className="wh-h">{C.verify.in}</h3>
            <Samples samples={VERIFY_SAMPLES} />
            {SDK_STATUS.cli ? (
              <div className="cmd">
                <span className="p">$</span>
                <code>{CLI}</code>
                <button
                  type="button"
                  className="iconbtn copy push"
                  data-copy
                  aria-label="Copy command"
                >
                  <Copy className="lucide" aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </Inspector>
  );
}
