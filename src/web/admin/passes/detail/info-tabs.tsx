import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import {
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  KeyValue,
  Spinner,
  Timeline,
  type TimelineItem,
} from '../../../ui/index.ts';
import { usePassAudit } from '../api.ts';
import { formatDate } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;

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
