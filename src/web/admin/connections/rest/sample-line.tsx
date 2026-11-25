import type { z } from 'zod';
import type { ProbeDetectionsSchema } from '@/shared/contracts/connection-probe.ts';
import { Badge } from '../../../ui/index.ts';
import type { ProbeFailure, ProbeResult } from './probe-api.ts';

const kib = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** The sample's one status line: what came back, or the single sentence of what went wrong. */
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
        <p
          role="alert"
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-danger"
        >
          <span>{failure.line}</span>
          <code className="font-mono text-xs">{failure.code}</code>
        </p>
      ) : req && result ? (
        <p
          role="status"
          className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg-muted"
        >
          <Badge tone="success">{req.status}</Badge>
          <span>
            {result.durationMs} ms · {kib(req.bytes)}
          </span>
          {perMinute ? (
            <span>
              Limit {limit?.limit}. Try {perMinute} requests per minute.
            </span>
          ) : null}
        </p>
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
