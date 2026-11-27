import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { WB_PASSES } from '@/shared/copy/workbench-passes.ts';
import { wbPath } from '@/shared/workbench.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { readLog } from '../logs/api.ts';
import { WbLink } from '../logs/link.tsx';
import { shownPath } from '../logs/model.ts';
import { ToolFailed } from '../states/states.tsx';

const SHOWN = 20;

/** The calls that touched this pass, newest first, each opening in Logs; Logs holds the rest. */
export function CallsTab({ orgId, passId }: { orgId: string; passId: string }) {
  const api = useToolApi();
  const key = useToolKey();
  const calls = useQuery({
    queryKey: ['workbench', 'passes', 'calls', passId, ...key],
    queryFn: ({ signal }) => readLog(api, { pass: passId }, { signal }),
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
  });
  if (calls.isPending) return <Skeleton className="h-24 w-full" />;
  if (calls.isError) return <ToolFailed error={calls.error} onRetry={() => void calls.refetch()} />;
  const rows = calls.data.items.slice(0, SHOWN);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{WB_PASSES.calls.empty}</p>
      ) : (
        <ul aria-label="Calls" className="flex flex-col divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id}>
              <WbLink
                href={wbPath(orgId, 'logs', { hash: r.id })}
                className="flex min-h-11 min-w-0 items-center gap-3 py-2 text-sm text-fg hover:text-fg-strong"
              >
                <BenchTime at={r.at} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {r.method} {shownPath(r)}
                </span>
                <StatusChip status={r.status} />
              </WbLink>
            </li>
          ))}
        </ul>
      )}
      <WbLink
        href={wbPath(orgId, 'logs', { query: { pass: passId } })}
        className="inline-flex items-center gap-1 self-start text-sm text-accent-fg hover:underline"
      >
        {WB_PASSES.calls.all}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </WbLink>
    </div>
  );
}
