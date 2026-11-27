import { useQuery } from '@tanstack/react-query';
import { type DeveloperFunnel, DeveloperFunnelSchema } from '@/shared/contracts/developer.ts';
import { api } from '@/web/lib/api.ts';
import { formatCount } from '@/web/lib/format.ts';
import { Card, CardBody, ErrorState, SkeletonRows } from '@/web/ui/index.ts';

/** Page view to first pass reads in the unit that fits: seconds, minutes or hours. */
export function formatSpan(ms: number | null): string {
  if (ms === null) return 'None yet';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`;
}

export function formatShare(share: number | null): string {
  return share === null ? 'None yet' : `${Math.round(share * 100)}%`;
}

function steps(f: DeveloperFunnel) {
  return [
    { id: 'sandboxes', label: 'Sandboxes', n: f.sandboxes },
    { id: 'viewed', label: 'Viewed quickstart', n: f.viewed },
    { id: 'called', label: 'Called the API', n: f.called },
    { id: 'passed', label: 'Made a pass', n: f.passed },
    { id: 'previewed', label: 'Previewed it', n: f.previewed },
  ];
}

/** Across all organizations: the quickstart funnel ignores the overview's organization filter and range. */
export function DeveloperFunnelTile() {
  const funnel = useQuery({
    queryKey: ['metrics', 'platform', 'developer'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/platform/developer', DeveloperFunnelSchema, { signal }),
    staleTime: 60_000,
  });
  const f = funnel.data;
  return (
    <Card>
      <CardBody>
        <section aria-label="Developer funnel" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-semibold text-fg-strong">Developer funnel</h2>
            {f ? <p className="text-xs text-fg-muted">{`Last ${f.windowDays} days`}</p> : null}
          </div>
          {funnel.isPending ? (
            <SkeletonRows rows={3} label="Loading developer funnel" />
          ) : funnel.isError || !f ? (
            <ErrorState inline error={funnel.error} onRetry={() => funnel.refetch()} />
          ) : (
            <div className="grid gap-x-10 gap-y-5 lg:grid-cols-[minmax(0,1fr)_auto]">
              <ol className="flex flex-col gap-2.5">
                {steps(f).map((s) => (
                  <li
                    key={s.id}
                    className="grid grid-cols-[minmax(7rem,9.5rem)_minmax(0,1fr)_2.5rem] items-center gap-2 sm:gap-3 text-sm"
                  >
                    <span className="truncate text-fg-muted">{s.label}</span>
                    <span aria-hidden className="h-2 rounded-full bg-surface-sunken">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{
                          width: `${f.sandboxes ? Math.min(100, (s.n / f.sandboxes) * 100) : 0}%`,
                        }}
                      />
                    </span>
                    <span className="text-right font-medium text-fg-strong tabular-nums">
                      {formatCount(s.n)}
                    </span>
                  </li>
                ))}
              </ol>
              <dl className="grid grid-cols-3 gap-x-6 gap-y-3 self-start lg:grid-cols-1">
                {[
                  ['Completion', formatShare(f.completion)],
                  ['Median to pass', formatSpan(f.ttfpP50Ms)],
                  ['90th percentile', formatSpan(f.ttfpP90Ms)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-fg-muted">{k}</dt>
                    <dd className="text-lg font-semibold text-fg-strong tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
