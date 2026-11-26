import { useMemo, useState } from 'react';
import type { ApiRail, RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchCode } from '../bench/code-block.tsx';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Trace, type TraceNode, traceNodes } from '../bench/trace.tsx';
import { COPY_LANGS } from '../console/copy-as.ts';
import type { CopyAsItem } from '../ui/copy-as-menu.tsx';
import { codeOf } from './curl.ts';
import { keyTail, shownPath } from './model.ts';
import { builderLink, type OpIndex, runAgainLink } from './ops.ts';
import { duration } from './row-format.ts';
import { type Detail, useCausedEvents } from './use-detail.ts';

const C = LOGS_BENCH_COPY.inspector;
const TABS = [
  { id: 'request', label: C.request },
  { id: 'response', label: C.response },
] as const;
const NO_CODES: ReadonlySet<string> = new Set();

/** The strip's key by its name; another key by the end of its id. */
const keyNode = (keyId: string | null, key: ApiRail['key']): TraceNode | null =>
  keyId
    ? {
        kind: 'key',
        id: keyId,
        prefix: 'key',
        text: key?.id === keyId ? `${key.name} ${key.prefix}…` : keyTail(keyId),
      }
    : null;

/**
 * The selected request: its status and request id, the facts in one line, Request and Response as tabs (a
 * call with no body to show says so on its tab, never an empty half), Run again, and the Trace.
 * `row` is the list's entry, so the header is there before the bodies are.
 */
export function LogInspector({
  row,
  detail,
  rail,
  ops,
  onPrev,
  onNext,
}: {
  row: RequestLogEntry;
  detail: Detail | null;
  rail: ApiRail['key'];
  ops: OpIndex;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [tab, setTab] = useState<string>('request');
  const full = detail?.kind === 'ready' ? detail.row : null;
  const events = useCausedEvents(full);
  const shown = shownPath(row);
  const items = useMemo<CopyAsItem[]>(
    () =>
      full
        ? COPY_LANGS.map((l) => ({
            key: l.lang,
            label: l.label,
            text: () => codeOf(l.lang, full, location.origin),
          }))
        : [],
    [full],
  );
  const base = builderLink(ops, row.method, row.route);
  const nodes: TraceNode[] = [
    ...(keyNode(row.keyId, rail) ? [keyNode(row.keyId, rail) as TraceNode] : []),
    ...traceNodes({
      request: { id: row.requestId, method: row.method, path: shownPath(row), status: row.status },
      events,
    }),
  ];
  const body = (which: 'request' | 'response') => {
    if (!full) {
      return (
        <p className="logs-quiet" aria-busy={detail?.kind !== 'failed' || undefined}>
          {detail?.kind === 'failed' ? C.failed : LOGS_BENCH_COPY.inspector.loading}
        </p>
      );
    }
    if (!full.hasBodies) return <p className="logs-quiet">{C.bodiesGone}</p>;
    return which === 'request' ? (
      <BenchCode
        label={C.request}
        body={full.requestBody}
        items={items}
        codes={NO_CODES}
        empty={C.noBody}
      />
    ) : (
      <BenchCode label={C.response} body={full.responseBody} codes={NO_CODES} empty={C.noBody} />
    );
  };
  return (
    <Inspector
      title={
        <span title={`${row.method} ${shown}`}>
          {row.method} {shown}
        </span>
      }
      label={`${C.request} ${row.method} ${shown}`}
      itemKey={row.id}
      status={<StatusChip status={row.status} />}
      id={<IdChip kind="request" id={row.requestId} />}
      actions={
        <>
          {base ? (
            <a className="btn outline sm" href={runAgainLink(base, full?.requestBody ?? null)}>
              {C.runAgain}
            </a>
          ) : null}
          {row.code ? (
            <a
              className="btn outline sm mono"
              href={`${PATHS.errors}/${encodeURIComponent(row.code)}`}
            >
              {row.code}
            </a>
          ) : null}
        </>
      }
      facts={
        <span className="logs-facts">
          <BenchTime at={row.at} mode="full" />
          <span>{duration(row.durationMs)}</span>
          {row.via === 'try' ? (
            <span>
              {row.client === 'portal' ? LOGS_BENCH_COPY.via.portal : LOGS_BENCH_COPY.via.try}
            </span>
          ) : row.client ? (
            <span className="mono">{row.client}</span>
          ) : null}
          {full?.bodiesExpireAt ? (
            <span>
              {C.expires} <BenchTime at={full.bodiesExpireAt} mode="until" />
            </span>
          ) : null}
        </span>
      }
      tabs={TABS}
      tab={tab}
      onTab={setTab}
      onPrev={onPrev}
      onNext={onNext}
      trace={<Trace nodes={nodes} />}
    >
      {body(tab === 'response' ? 'response' : 'request')}
    </Inspector>
  );
}
