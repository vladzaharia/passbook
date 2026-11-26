import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RequestLogPageSchema } from '@/shared/contracts/developer.ts';
import { WB_KEYS_COPY as C } from '@/shared/copy/workbench-keys.ts';
import { wbPath } from '@/shared/workbench.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { Card, CardBody, CardHeader } from '../../ui/card.tsx';
import { ErrorState } from '../../ui/error-state.tsx';
import { RelTime, useNow } from '../../ui/rel-time.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { StatusChip } from '../bench/status-chip.tsx';

/** The last calls a Test key made, newest first, each opening the Logs tool at that call. */
export function RecentCalls({ orgId, keyId }: { orgId: string; keyId: string }) {
  const api = useToolApi();
  const tool = useToolKey();
  const now = useNow();
  const calls = useQuery({
    queryKey: ['workbench-key-calls', ...tool, orgId, keyId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/request-logs', RequestLogPageSchema, {
        query: { orgId, key: keyId, limit: 5 },
        signal,
      }),
  });
  return (
    <Card>
      <CardHeader title={C.recent.title} />
      {calls.isPending ? (
        <SkeletonRows label="Loading calls" />
      ) : calls.isError ? (
        <ErrorState
          inline
          subject="calls"
          error={calls.error}
          onRetry={() => void calls.refetch()}
        />
      ) : calls.data.items.length === 0 ? (
        <CardBody>
          <p className="text-sm text-fg-muted">{C.recent.none}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {calls.data.items.map((c) => (
            <li key={c.id}>
              <Link
                to={wbPath(orgId, 'logs', { hash: c.id })}
                className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm hover:bg-surface-hover"
              >
                <span className="w-14 shrink-0 font-mono text-xs text-fg-muted">{c.method}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{c.path}</span>
                <StatusChip status={c.status} />
                <span className="shrink-0 text-xs text-fg-muted">
                  <RelTime at={c.at} now={now} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
