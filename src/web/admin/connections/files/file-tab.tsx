import { ErrorState, SkeletonRows } from '../../../ui/index.ts';
import { CurrentRevision } from './current-revision.tsx';
import type { OnMissing } from './diff-summary.tsx';
import { useRevisions } from './files-api.ts';
import { PendingRevision } from './pending-revision.tsx';
import { RevisionHistory } from './revision-history.tsx';
import { useRevisionUpload } from './use-revision-upload.ts';

/** A file-upload connection's File tab: the version waiting to apply, the one in use, and the history. */
export function FileTab({
  connectionId,
  onMissing,
  canManage,
}: {
  connectionId: string;
  onMissing: OnMissing;
  canManage: boolean;
}) {
  const q = useRevisions(connectionId);
  const upload = useRevisionUpload(connectionId);
  if (q.isError) return <ErrorState inline error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <SkeletonRows rows={3} label="Loading file" />;
  const rows = q.data.items;
  const pending = rows.find((r) => r.state === 'pending');
  const current = rows.find((r) => r.state === 'current');
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {pending ? (
        <PendingRevision
          key={pending.id}
          connectionId={connectionId}
          revision={pending}
          onMissing={onMissing}
          canManage={canManage}
        />
      ) : null}
      {current ? (
        <CurrentRevision
          key={current.id}
          revision={current}
          upload={upload}
          canManage={canManage}
        />
      ) : null}
      <RevisionHistory revisions={rows} />
    </div>
  );
}
