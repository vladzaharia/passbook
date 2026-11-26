import type { z } from 'zod';
import type { ProbeDetectionsSchema } from '@/shared/contracts/connection-probe.ts';
import { Badge } from '../../../ui/index.ts';
import { ExplorerBuddy, moodOf } from './explorer-buddy.tsx';
import type { ProbeFailure, ProbeResult } from './probe-api.ts';

const kib = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** "Found 25 records": the whole list when the sample cut it, else what the page holds. */
function found(result: ProbeResult, detections: z.infer<typeof ProbeDetectionsSchema> | null) {
  const lead = detections?.records[0];
  const total = result.pruned?.arrays.find((a) => a.pointer === lead?.pointer)?.total;
  const n = total ?? lead?.count ?? 0;
  return `Found ${n} ${n === 1 ? 'record' : 'records'}`;
}

/** The sample's status: a buddy with what came back, or the single sentence of what went wrong. */
export function SampleLine({
  result,
  failure,
  ready,
  detections,
}: {
  result: ProbeResult | undefined;
  failure: ProbeFailure | undefined;
  ready: boolean;
  detections: z.infer<typeof ProbeDetectionsSchema> | null;
}) {
  const req = result?.request;
  const limit = detections?.rateLimit;
  const perMinute =
    limit?.limit && limit.windowSeconds
      ? Math.floor(((limit.limit * 60) / limit.windowSeconds) * 0.8)
      : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {failure ? (
        <ExplorerBuddy mood={moodOf(failure.code)}>
          <p
            role="alert"
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-danger"
          >
            <span>{failure.line}</span>
            <code className="font-mono text-xs">{failure.code}</code>
          </p>
        </ExplorerBuddy>
      ) : req && result ? (
        <ExplorerBuddy mood="happy">
          <p role="status" className="flex min-w-0 flex-col gap-0.5 text-sm text-fg-muted">
            <span className="font-medium text-fg-strong">{found(result, detections)}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone="success">{req.status}</Badge>
              {result.durationMs} ms · {kib(req.bytes)}
              {perMinute ? ` · Limit ${limit?.limit}. Try ${perMinute} requests per minute.` : ''}
            </span>
          </p>
        </ExplorerBuddy>
      ) : (
        <p className="text-sm text-fg-muted">
          {ready
            ? 'Fetch a sample to pick fields from it.'
            : 'Set the base URL and list path first.'}
        </p>
      )}
      {req ? (
        <code className="min-w-0 truncate font-mono text-xs text-fg-muted" title={req.url}>
          GET {req.url}
        </code>
      ) : null}
    </div>
  );
}
