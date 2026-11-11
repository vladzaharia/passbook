import { Link } from '@tanstack/react-router';
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
import {
  assessmentState,
  componentLink,
  headline,
  pillStatus,
  problems,
  summaryLine,
} from '../status/groups.ts';
import { COMPONENT_ICON } from '../status/icons.ts';
import { useStatus } from '../status/queries.ts';
import './overview.css';

/** Platform-wide checks stay separate from the overview's organization and mode filters. */
export function Health() {
  const status = useStatus();
  const identities = useIdentityOptions();
  const attention = identityAttention(identities.data?.items ?? [], Date.now());
  const components = status.data?.components ?? [];
  const bad = problems(components);
  const checkedAt = Math.max(0, ...components.map((c) => c.checkedAt));
  return (
    <Card className="wl-overview-focus rounded-[24px] shadow-elevation-2">
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
            <div className="rounded-xl border border-border bg-surface-sunken/50 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="font-medium text-fg-strong">{headline(components)}</p>
                <StatusPill status={assessmentState(components)} />
                <p className="text-xs text-fg-muted">
                  {checkedAt > 0 ? `Checked ${formatDateTime(checkedAt)}` : 'Last checked: unknown'}
                </p>
              </div>
              {bad.length > 0 ? (
                <div className="mt-3">
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
                </div>
              ) : null}
            </div>
          )}
        </section>
      </CardBody>
    </Card>
  );
}
