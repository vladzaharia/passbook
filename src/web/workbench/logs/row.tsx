import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import type { Method } from '../../developers/model/types.ts';
import { MethodPill } from '../../developers/ui/method-pill.tsx';
import type { BenchRowParts } from '../bench/list.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { duration, type PathRun, pathParts, SLOW_MS } from './row-format.ts';

const runs = (list: PathRun[]) =>
  list.map((r, i) =>
    r.id ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
      <span key={i} className="logs-id">
        {r.text}
      </span>
    ) : (
      r.text
    ),
  );

/** Who made the call: Run here, the portal reading for itself, or the caller's tool by its short name. */
const clientLabel = (row: Pick<RequestLogEntry, 'via' | 'client'>): string | null =>
  row.via === 'try'
    ? row.client === 'portal'
      ? LOGS_BENCH_COPY.via.portal
      : LOGS_BENCH_COPY.via.try
    : row.client;

/** The client chip (DS6): a quiet mono tag, so a row says whether curl, a script or the Console sent it. */
export function ClientChip({ row }: { row: Pick<RequestLogEntry, 'via' | 'client'> }) {
  const label = clientLabel(row);
  return label ? (
    <span className="logs-client" data-via={row.via ?? undefined}>
      {label}
    </span>
  ) : null;
}

/**
 * One request in the bench list: time and method, the path cut in the middle (ids dimmed, the whole of it
 * in the title), the error code or the portal tag, then the status and the duration.
 */
export function logRow(row: RequestLogEntry): BenchRowParts {
  const { full, head, tail } = pathParts(row.path, row.query);
  return {
    lead: (
      <>
        <BenchTime at={row.at} />
        <MethodPill method={row.method.toLowerCase() as Method} />
      </>
    ),
    title: (
      <span className="logs-path" title={full}>
        <span className="logs-head">{runs(head)}</span>
        <span className="logs-tail">{runs(tail)}</span>
      </span>
    ),
    meta: (
      <>
        {row.code ? <code className="logs-err">{row.code}</code> : null}
        <ClientChip row={row} />
      </>
    ),
    trail: (
      <>
        <StatusChip status={row.status} />
        <span className="logs-ms" data-slow={row.durationMs >= SLOW_MS || undefined}>
          {duration(row.durationMs)}
        </span>
      </>
    ),
  };
}
