import { useMemo } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { WB_STATES } from '../../../shared/copy/workbench-states.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { CopyAsItem } from '../../developers/ui/copy-as-menu.tsx';
import { BenchCode } from '../bench/code-block.tsx';
import { IdChip } from '../bench/id-chip.tsx';
import { Inspector } from '../bench/inspector.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { Trace, type TraceNode, traceNodes } from '../bench/trace.tsx';
import { COPY_LANGS } from '../console/copy-as.ts';
import { codeOf } from './curl.ts';
import { HeadersTab } from './headers-tab.tsx';
import { WbLink } from './link.tsx';
import { keyTail, shownPath } from './model.ts';
import { consoleLink, type OpIndex, opOf } from './ops.ts';
import { ClientChip } from './row.tsx';
import { duration } from './row-format.ts';
import { type Detail, useCausedEvents } from './use-detail.ts';

const C = LOGS_BENCH_COPY.inspector;
const TABS = [
  { id: 'request', label: C.request },
  { id: 'response', label: C.response },
  { id: 'headers', label: C.headers },
] as const;
const NO_CODES: ReadonlySet<string> = new Set();

/** A key by its name; one the list does not name by the end of its id. */
const keyNode = (keyId: string | null, name: string | undefined): TraceNode | null =>
  keyId ? { kind: 'key', id: keyId, prefix: 'key', text: name ?? keyTail(keyId) } : null;

/** Bodies the org does not record: the one line, and for an admin the way to turn them on. */
function BodiesOff({ adminHref }: { adminHref: string | null }) {
  return (
    <div className="logs-off" role="status">
      <p>{WB_STATES.bodiesOff.title}</p>
      {adminHref ? (
        <a className="btn outline sm" href={adminHref}>
          {WB_STATES.bodiesOff.admin}
        </a>
      ) : null}
    </div>
  );
}

/**
 * The selected request: its status and request id, the facts in one line, Request and Response as tabs (a
 * call with no body to show says so on its tab, never an empty half), Run again, and the Trace.
 * `row` is the list's entry, so the header is there before the bodies are.
 */
export function LogInspector({
  row,
  detail,
  orgId,
  keyName,
  adminHref,
  ops,
  tab,
  onTab,
  onPrev,
  onNext,
}: {
  row: RequestLogEntry;
  detail: Detail | null;
  orgId: string;
  /** The key's name, when the Key filter knows it. */
  keyName?: string;
  /** Where an admin turns bodies on, or null for anyone else. */
  adminHref: string | null;
  ops: OpIndex;
  /** Kept by the tool: the pane is drawn again when the window changes shape. */
  tab: string;
  onTab: (tab: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
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
  const op = opOf(ops, row.method, row.route);
  const key = keyNode(row.keyId, keyName);
  const nodes: TraceNode[] = [
    ...(key ? [key] : []),
    ...traceNodes({
      request: { id: row.requestId, method: row.method, path: shownPath(row), status: row.status },
      events,
    }),
  ];
  const body = (which: 'request' | 'response' | 'headers') => {
    if (which === 'headers' && full) return <HeadersTab headers={full.headers} />;
    if (!full) {
      return (
        <p className="logs-quiet" aria-busy={detail?.kind !== 'failed' || undefined}>
          {detail?.kind === 'failed' ? C.failed : LOGS_BENCH_COPY.inspector.loading}
        </p>
      );
    }
    if (which === 'headers') return null;
    if (!full.bodiesRecorded) return <BodiesOff adminHref={adminHref} />;
    if (!full.hasBodies) return <p className="logs-quiet">{C.bodiesGone}</p>;
    return (
      <>
        {which === 'request' ? (
          <BenchCode
            label={C.body}
            body={full.requestBody}
            items={items}
            codes={NO_CODES}
            empty={C.noBody}
          />
        ) : (
          <BenchCode label={C.body} body={full.responseBody} codes={NO_CODES} empty={C.noBody} />
        )}
        {full.bodiesTruncated ? <p className="logs-quiet logs-cut">{C.truncated}</p> : null}
      </>
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
          {op ? (
            <WbLink className="btn outline sm" href={consoleLink(orgId, op, row.requestId)}>
              {C.openInConsole}
            </WbLink>
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
          <ClientChip row={row} />
          {row.apiVersion ? <span className="mono">{row.apiVersion}</span> : null}
          {full?.bodiesExpireAt ? (
            <span>
              {C.expires} <BenchTime at={full.bodiesExpireAt} mode="until" />
            </span>
          ) : null}
        </span>
      }
      tabs={TABS}
      tab={tab}
      onTab={onTab}
      onPrev={onPrev}
      onNext={onNext}
      trace={<Trace nodes={nodes} />}
    >
      {body(tab === 'response' || tab === 'headers' ? tab : 'request')}
    </Inspector>
  );
}
