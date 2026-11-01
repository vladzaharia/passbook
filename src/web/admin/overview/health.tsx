import { Link } from '@tanstack/react-router';
import {
  Card,
  CardBody,
  CardHeader,
  CardLink,
  EntityArt,
  ErrorState,
  ListRow,
  ListRows,
  SkeletonRows,
  StatusPill,
} from '@/web/ui/index.ts';
import { componentLink, pillStatus, problems, summaryLine } from '../status/groups.ts';
import { COMPONENT_ICON } from '../status/icons.ts';
import { useStatus } from '../status/queries.ts';
import { formatDateTime } from './format.ts';

/** Failing and degraded leaves, linked to the page that owns them; "All good" otherwise. */
export function Health() {
  const status = useStatus();
  const bad = status.data ? problems(status.data.components) : [];
  const checkedAt = Math.max(0, ...(status.data?.components.map((c) => c.checkedAt) ?? []));
  return (
    <Card className="flex h-full flex-col">
      <CardHeader title="Health" actions={<CardLink to="/admin/status">Status</CardLink>} />
      <CardBody className="flex flex-1 flex-col">
        {status.isPending ? (
          <SkeletonRows rows={2} label="Loading health" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : bad.length > 0 ? (
          <>
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
                        to={(componentLink(c) ?? '/admin/status') as never}
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
            {checkedAt > 0 ? (
              <p className="mt-auto pt-4 text-xs text-fg-muted">
                Checked {formatDateTime(checkedAt)}
              </p>
            ) : null}
          </>
        ) : (
          <div
            data-art-host=""
            className="flex flex-1 flex-col items-center justify-center gap-2 py-2 text-center"
          >
            <EntityArt name="pulse" size="sm" />
            <StatusPill status="all_good" />
            {checkedAt > 0 ? (
              <p className="text-xs text-fg-muted">Checked {formatDateTime(checkedAt)}</p>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
