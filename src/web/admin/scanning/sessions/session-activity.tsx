import type { z } from 'zod';
import type { SessionActivitySchema } from '@/shared/contracts/scanning-sessions.ts';
import { formatTime } from '@/web/lib/format.ts';
import { Card, CardBody, CardHeader, StatusPill } from '@/web/ui/index.ts';

export function SessionActivity({ items }: z.infer<typeof SessionActivitySchema>) {
  return (
    <Card>
      <CardHeader title="Recent session activity" />
      <CardBody>
        {!items.length ? (
          <p className="text-sm text-fg-muted">Check-ins from every device will appear here.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((row) => (
              <li
                key={row.id}
                className="flex min-h-14 flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg-strong">
                    {row.title ?? 'Unknown pass'}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {row.deviceName} · {formatTime(row.at)}
                  </p>
                </div>
                <StatusPill
                  status={row.outcome}
                  tone={
                    row.outcome === 'ok'
                      ? 'success'
                      : row.outcome === 'refused'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {row.outcome === 'ok'
                    ? row.direction === 'out'
                      ? 'Checked out'
                      : 'Checked in'
                    : row.outcome === 'undone'
                      ? 'Undone'
                      : 'Not accepted'}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
