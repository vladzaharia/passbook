import type { z } from 'zod';
import type { ConnectionRunSchema } from '@/shared/contracts/connections.ts';
import { ErrorState, SkeletonRows, toast } from '../../../ui/index.ts';
import { useConnectionActions } from '../api.ts';
import { CurrentRevision } from './current-revision.tsx';
import type { OnMissing } from './diff-summary.tsx';
import { useRevisions } from './files-api.ts';
import { PendingRevision } from './pending-revision.tsx';
import { RevisionHistory } from './revision-history.tsx';
import { useApplyWatch } from './use-apply-watch.ts';
import { useRevisionUpload } from './use-revision-upload.ts';

/** A file-upload connection's File tab: the version waiting to apply, the one in use, and the history. */
export function FileTab({
  connectionId,
  onMissing,
  canManage,
  enabled,
  runs,
}: {
  connectionId: string;
  onMissing: OnMissing;
  canManage: boolean;
  /** The connection is on: a sync can run. */
  enabled: boolean;
  /** Newest first. */
  runs: readonly z.infer<typeof ConnectionRunSchema>[];
}) {
  const q = useRevisions(connectionId);
  const upload = useRevisionUpload(connectionId);
  const { sync } = useConnectionActions(connectionId);
  const current = q.data?.items.find((r) => r.state === 'current');
  const watch = useApplyWatch(connectionId, current?.applied ?? true, runs);
  if (q.isError) return <ErrorState inline error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <SkeletonRows rows={3} label="Loading file" />;
  const rows = q.data.items;
  const pending = rows.find((r) => r.state === 'pending');
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {pending ? (
        <PendingRevision
          key={pending.id}
          connectionId={connectionId}
          revision={pending}
          onMissing={onMissing}
          canManage={canManage}
          onApplied={watch.begin}
        />
      ) : null}
      {current ? (
        <CurrentRevision
          key={current.id}
          revision={current}
          upload={upload}
          canManage={canManage}
          applying={watch.applying}
          failed={runs[0]?.outcome === 'error'}
          onSync={
            canManage && enabled
              ? () =>
                  sync.mutate(undefined, {
                    onSuccess: watch.begin,
                    onError: (error) => toast.error(error, 'Could not sync'),
                  })
              : undefined
          }
        />
      ) : null}
      <RevisionHistory revisions={rows} />
    </div>
  );
}
