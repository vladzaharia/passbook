import { Link } from '@tanstack/react-router';
import { cn } from '@/web/lib/cn.ts';
import {
  Button,
  Card,
  CardBody,
  ErrorState,
  ListRow,
  ListRows,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { ATTENTION_COPY, identityAttention } from '../identities/attention.ts';
import { useIdentityOptions } from '../identities/queries.ts';
import { componentLink, headline, pillStatus, problems, summaryLine } from '../status/groups.ts';
import { COMPONENT_ICON } from '../status/icons.ts';
import { breakdown, OVERALL_TONE, overallTone } from '../status/overall.ts';
import { useStatus } from '../status/queries.ts';
import './overview.css';

/** Platform-wide checks stay separate from the overview's organization and mode filters. */
export function Health() {
  const status = useStatus();
  const identities = useIdentityOptions();
  const attention = identityAttention(identities.data?.items ?? [], Date.now());
  const components = status.data?.components ?? [];
  const bad = problems(components);
  const tone = OVERALL_TONE[overallTone(components)];
  const checkedAt = Math.max(0, ...components.map((c) => c.checkedAt));
  return (
    <Card className="rounded-[24px] shadow-elevation-2">
      <CardBody className="p-5 sm:p-6">
        <section aria-label="Platform health" className="flex flex-col gap-4">
          {attention ? (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <h2 id="readiness-title" className="text-xl font-semibold text-fg-strong">
                  {attention.count === 1
                    ? 'One Apple signing identity needs attention'
                    : `${attention.count} Apple signing identities need attention`}
                </h2>
                <p className="mt-1 text-sm text-fg-muted">
                  {`${attention.identity.label}: certificate ${ATTENTION_COPY[attention.reason]}.`}
                </p>
              </div>
              <Button asChild>
                <Link to="/admin/identities">Review identities</Link>
              </Button>
            </div>
          ) : null}
          {status.isPending ? (
            <SkeletonRows rows={2} label="Loading health" />
          ) : status.isError || !status.data ? (
            <ErrorState inline error={status.error} onRetry={() => status.refetch()} />
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <tone.icon aria-hidden className={cn('mt-0.5 size-7 shrink-0', tone.text)} />
                <div className="min-w-0 flex-1 basis-56">
                  <h2 className="text-lg font-semibold text-fg-strong">{headline(components)}</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    {breakdown(components) || 'No checks reported'}
                  </p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {checkedAt > 0 ? (
                      <>
                        Checked{' '}
                        <time dateTime={new Date(checkedAt).toISOString()}>
                          {formatDateTime(checkedAt)}
                        </time>
                      </>
                    ) : (
                      'Last checked: unknown'
                    )}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/status">View status</Link>
                </Button>
              </div>
              {bad.length > 0 ? (
                <ListRows label="Needs attention">
                  {bad.slice(0, 6).map((c) => {
                    const Icon = COMPONENT_ICON[c.kind];
                    return (
                      <ListRow
                        key={c.id}
                        className="relative"
                        leading={<Icon aria-hidden />}
                        title={
                          <Link
                            to={componentLink(c) ?? '/admin/status'}
                            className="rounded-sm after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          >
                            {c.id === 'connections' ? 'All connections' : c.label}
                          </Link>
                        }
                        meta={summaryLine(c)}
                        trailing={<StatusPill status={pillStatus(c)} />}
                      />
                    );
                  })}
                </ListRows>
              ) : null}
            </>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
