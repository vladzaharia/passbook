import type { EntityChipProps } from '../../../ui/index.ts';
import {
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Handoff,
  SkeletonTimeline,
  Timeline,
  type TimelineItem,
} from '../../../ui/index.ts';
import { usePassAudit } from '../api.ts';

const ACTOR: Record<string, { kind: EntityChipProps['kind']; to?: (id: string) => string }> = {
  user: { kind: 'user', to: (id) => `/admin/users/${id}` },
  api_key: { kind: 'apiKey' },
  connection: { kind: 'connection', to: (id) => `/admin/connections/${id}` },
};

/** The pass's audit trail as a timeline: action glyphs, who did it as an entity chip. */
export function ActivityTab({ passId, active }: { passId: string; active: boolean }) {
  const audit = usePassAudit(passId, active);
  if (audit.isError)
    return <ErrorState inline error={audit.error} onRetry={() => void audit.refetch()} />;
  const items: TimelineItem[] = (audit.data?.items ?? []).map((e) => {
    const actor = e.actorId ? ACTOR[e.actorType] : undefined;
    return {
      id: String(e.id),
      action: e.action,
      time: e.at,
      ...(actor && e.actorId
        ? {
            actor: {
              kind: actor.kind,
              id: e.actorId,
              name: e.actorLabel,
              ...(actor.to ? { to: actor.to(e.actorId) } : {}),
            },
          }
        : { actorLabel: e.actorLabel ?? (e.actorType === 'system' ? 'System' : e.actorType) }),
    };
  });
  return (
    <Handoff loading={audit.isPending} skeleton={<SkeletonTimeline label="Loading activity" />}>
      <Card>
        {items.length === 0 ? (
          <EmptyState inline art="activity" title="No activity" />
        ) : (
          <CardBody>
            <Timeline items={items} />
          </CardBody>
        )}
      </Card>
    </Handoff>
  );
}
