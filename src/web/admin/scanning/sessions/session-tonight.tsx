import { useQuery } from '@tanstack/react-query';
import { ScanSummarySchema } from '@/shared/contracts/scan-session.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatCount, formatTime } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Card, CardBody, CardHeader, ErrorState } from '@/web/ui/index.ts';

function List({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; value: string }[];
}) {
  if (!rows.length) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-sm font-semibold text-fg-muted">{title}</h3>
      <ul className="divide-y divide-border text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex justify-between gap-3 py-1.5">
            <span>{row.label}</span>
            <strong className="tabular-nums">{row.value}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The whole session's last day, for Managers; hidden from anyone the server refuses. */
export function SessionTonight({ sessionId }: { sessionId: string }) {
  const mode = useMode();
  const query = useQuery({
    queryKey: ['admin', 'scanning', 'sessions', sessionId, 'tonight', mode],
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/scanning-sessions/${encodeURIComponent(sessionId)}/summary`,
        ScanSummarySchema,
        {
          signal,
        },
      ),
    refetchInterval: 30_000,
    retry: false,
  });
  if (query.isError && isApiError(query.error) && [403, 404].includes(query.error.status))
    return null;
  const s = query.data;
  return (
    <Card>
      <CardHeader title="Tonight" />
      <CardBody>
        {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}
        {s ? (
          <div className="grid gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Scans', s.total],
                ['Done', s.ok],
                ['Heads-up', s.headsUp],
                ['Refused', s.refused],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-fg-muted">{label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <List
              title="By hour"
              rows={s.byHour.map((h) => ({
                key: String(h.start),
                label: formatTime(h.start, s.timeZone ?? undefined),
                value: formatCount(h.count),
              }))}
            />
            <List
              title="By staff"
              rows={s.byStaff.map((p) => ({
                key: p.staffId ?? 'none',
                label: p.name ?? 'No one signed in',
                value: `${formatCount(p.count)}${p.overrides ? ` · ${p.overrides} overrides` : ''}`,
              }))}
            />
            <List
              title="Overrides"
              rows={s.overrides.latest.map((o) => ({
                key: o.scanId,
                label: `${formatTime(o.at, s.timeZone ?? undefined)} · ${o.approvedBy ?? o.staffName ?? 'Unknown'}`,
                value: o.reason ?? '',
              }))}
            />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
