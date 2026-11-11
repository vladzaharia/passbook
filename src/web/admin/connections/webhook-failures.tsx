import { useState } from 'react';
import { resolveWebhookConfirm } from '../../lib/confirms.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusPill,
  toast,
} from '../../ui/index.ts';
import {
  type RetainedWebhook,
  useReplayWebhook,
  useResolveWebhook,
  useWebhookFailures,
} from './api.ts';

const UNCERTAIN = 'WEBHOOK_EFFECT_UNCERTAIN';

type Group = { event: string; latest: RetainedWebhook; count: number };

/** One row per event: the newest retained item decides the state; finished events drop out. */
function groupByEvent(items: RetainedWebhook[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const group = groups.get(item.eventRef);
    if (!group) groups.set(item.eventRef, { event: item.eventRef, latest: item, count: 1 });
    else {
      group.count += 1;
      if (item.receivedAt > group.latest.receivedAt) group.latest = item;
    }
  }
  return [...groups.values()]
    .filter((g) => g.latest.state !== 'resolved' && g.latest.state !== 'ignored')
    .sort((a, b) => b.latest.receivedAt - a.latest.receivedAt);
}

function describe(item: RetainedWebhook): { status: string; hint: string } {
  if (item.errorCode === UNCERTAIN)
    return {
      status: 'unknown',
      hint: 'Outcome unknown. Check the source system before replaying.',
    };
  if (item.state === 'pending') return { status: 'queued', hint: 'Waiting to run.' };
  if (item.state === 'blocked')
    return { status: 'blocked', hint: 'Needs an approved template release, then replay.' };
  return { status: 'failed', hint: 'Replay once the cause is fixed.' };
}

/** Webhook events that did not finish, with one replay each. */
export function WebhookFailures({
  connectionId,
  canManage,
}: {
  connectionId: string;
  canManage: boolean;
}) {
  const failures = useWebhookFailures(connectionId, true);
  const replay = useReplayWebhook(connectionId);
  const resolve = useResolveWebhook(connectionId);
  const [resolving, setResolving] = useState<Group>();
  const groups = groupByEvent(failures.data?.items ?? []);
  const run = (g: Group) =>
    replay
      .mutateAsync(g.latest.id)
      .then(() => toast.success('Replay queued'))
      .catch((error: unknown) => toast.error(error, 'Could not replay the webhook'));
  return (
    <Card>
      <CardHeader title="Webhook failures" />
      <CardBody className="flex flex-col gap-3">
        {failures.isPending ? (
          <Skeleton className="h-16" />
        ) : failures.isError ? (
          <ErrorState inline error={failures.error} onRetry={() => void failures.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState inline art="plugs" title="No failed webhooks" />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {groups.map((g) => {
              const { status, hint } = describe(g.latest);
              const replayable = g.latest.state === 'failed' || g.latest.state === 'blocked';
              return (
                <li key={g.event} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
                      <span className="break-all font-mono text-xs">{g.event}</span>
                      <StatusPill status={status} />
                    </p>
                    <p className="text-sm text-fg-muted">
                      {hint} Received {formatDateTime(g.latest.receivedAt)}
                      {g.count > 1 ? ` · ${g.count} deliveries` : ''}
                    </p>
                  </div>
                  {canManage && replayable && g.latest.errorCode !== UNCERTAIN ? (
                    <Button
                      size="sm"
                      variant="outline"
                      busy="spin"
                      loading={replay.isPending && replay.variables === g.latest.id}
                      aria-label={`Replay event ${g.event}`}
                      onClick={() => void run(g)}
                    >
                      Replay
                    </Button>
                  ) : null}
                  {canManage && g.latest.uncertainItems > 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Mark event ${g.event} resolved`}
                      onClick={() => setResolving(g)}
                    >
                      Mark resolved
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={resolving !== undefined}
        onOpenChange={(o) => !o && setResolving(undefined)}
        {...resolveWebhookConfirm(resolving?.event ?? 'event')}
        onConfirm={async () => {
          if (!resolving) return;
          const res = await resolve.mutateAsync(resolving.latest.id);
          toast.success(
            res.state === 'resolved' ? 'Marked resolved' : 'Marked resolved. Replay is still open',
          );
        }}
      />
    </Card>
  );
}
