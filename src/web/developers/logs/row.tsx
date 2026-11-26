import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import type { BenchRowParts } from '../bench/list.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import type { Method } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';
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

/** Where a call came from, when it was not your key: Run here, or the portal reading for itself. */
const viaLabel = (row: RequestLogEntry): string | null =>
  row.via !== 'try'
    ? null
    : row.client === 'portal'
      ? LOGS_BENCH_COPY.via.portal
      : LOGS_BENCH_COPY.via.try;

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
    meta: row.code ? <code className="logs-err">{row.code}</code> : viaLabel(row),
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
