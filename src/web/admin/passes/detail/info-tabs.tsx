import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  KeyValue,
  Spinner,
  StatusPill,
  Timeline,
  type TimelineItem,
  toast,
} from '../../../ui/index.ts';
import { useConnection } from '../../connections/api.ts';
import { usePassActions, usePassAudit } from '../api.ts';
import { formatDate } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;

export function ConnectionTab({ pass }: { pass: Pass }) {
  const connection = useConnection(pass.connectionId ?? undefined);
  const actions = usePassActions(pass.id);
  if (!pass.connectionId) {
    return <EmptyState title="Not bound to a connection" />;
  }
  if (connection.isPending) return <Spinner />;
  if (connection.isError) {
    return <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />;
  }
  const c = connection.data;
  const lastRun = c.runs[0];
  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="Connection"
        actions={
          <Button
            size="sm"
            loading={actions.refreshFromSource.isPending}
            onClick={() =>
              actions.refreshFromSource
                .mutateAsync()
                .then(() => toast.success('Refresh requested'))
                .catch((error: unknown) => toast.error(error))
            }
          >
            Refresh now
          </Button>
        }
      />
      <CardBody>
        <KeyValue
          items={[
            {
              label: 'Connection',
              value: (
                <Link
                  to={`/admin/connections/${c.id}` as never}
                  className="text-accent-fg hover:underline"
                >
                  {c.name}
                </Link>
              ),
            },
            {
              label: 'Health',
              value: <StatusPill status={healthKey(c.health)}>{c.health}</StatusPill>,
            },
            { label: 'External ID', value: pass.externalId, mono: true },
            { label: 'Last refreshed', value: formatDate(pass.lastRefreshedAt) },
            {
              label: 'Last run',
              value: lastRun ? `${lastRun.outcome} · ${formatDate(lastRun.startedAt)}` : null,
            },
            { label: 'Sync error', value: pass.syncErrorCode, mono: true },
          ]}
        />
      </CardBody>
    </Card>
  );
}

function healthKey(h: string): string {
  if (h === 'healthy') return 'verified';
  if (h === 'degraded' || h === 'failing') return h;
  return 'not_configured';
}

export function DevicesTab({ pass }: { pass: Pass }) {
  return (
    <Card className="max-w-md">
      <CardBody>
        <KeyValue
          items={[
            { label: 'Registered devices', value: String(pass.registrations) },
            { label: 'Last refreshed', value: formatDate(pass.lastRefreshedAt) },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function ActivityTab({ passId, active }: { passId: string; active: boolean }) {
  const audit = usePassAudit(passId, active);
  if (audit.isPending) return <Spinner />;
  if (audit.isError) {
    return <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />;
  }
  if (audit.data.items.length === 0) return <EmptyState title="No activity" />;
  const items: TimelineItem[] = audit.data.items.map((e) => ({
    id: String(e.id),
    title: e.action,
    time: e.at,
    description: `${e.actorType}${e.actorId ? ` ${e.actorId}` : ''}`,
  }));
  return <Timeline items={items} />;
}
