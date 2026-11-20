import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { ConfirmDialog, toast } from '@/web/ui/index.ts';
import { type RetentionScope, useReleaseHold } from './queries.ts';

/** Open while `holdId` is set. Deletion resumes for what the hold covered. */
export function ReleaseHoldDialog({
  scope,
  orgId,
  holdId,
  onClose,
}: {
  scope: RetentionScope;
  orgId: string;
  holdId: string | undefined;
  onClose: () => void;
}) {
  const release = useReleaseHold(scope, orgId);
  return (
    <ConfirmDialog
      open={holdId !== undefined}
      onOpenChange={(o) => !o && onClose()}
      title="Release hold?"
      description="Deletion resumes for these records, and records past their window are deleted on the next run. Every organization admin is emailed."
      confirmLabel={RETENTION_COPY.release}
      onConfirm={async () => {
        if (!holdId) return;
        await release.mutateAsync(holdId);
        toast.success('Hold released.');
      }}
    />
  );
}
