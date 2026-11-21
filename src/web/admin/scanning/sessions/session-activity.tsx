import type { z } from 'zod';
import type { SessionActivitySchema } from '@/shared/contracts/scanning-sessions.ts';
import { formatTime } from '@/web/lib/format.ts';
import { Card, CardBody, CardHeader, StatusPill } from '@/web/ui/index.ts';
import { scanStatusKey } from '../scans/outcome-copy.ts';
import { zoneName } from './zone-name.ts';

export function SessionActivity({
  items,
  timeZone,
}: z.infer<typeof SessionActivitySchema> & { timeZone?: string | undefined }) {
  return (
    <Card>
      <CardHeader title={`Recent session activity, ${zoneName(timeZone ?? null)}`} />
      <CardBody>
        {!items.length ? (
          <p className="text-sm text-fg-muted">No activity yet.</p>
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
                    {row.deviceName} · {formatTime(row.at, timeZone)}
                    {row.direction === 'out' && row.outcome === 'ok' ? ' · Check out' : ''}
                  </p>
                </div>
                <StatusPill status={scanStatusKey(row.outcome)} />
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
