import { Check, X } from 'lucide-react';
import { formatDateTime, pluralize } from '../../../lib/format.ts';
import { Button, Card, CardBody, CardHeader, toast } from '../../../ui/index.ts';
import { DiffSummary, type OnMissing } from './diff-summary.tsx';
import { useApplyRevision, useDiscardRevision } from './files-api.ts';
import type { Revision } from './status.ts';

/** A pending revision before Apply: what changes, what happens to the removed rows, then the choice. */
export function PendingRevision({
  connectionId,
  revision,
  onMissing,
  canManage,
  onApplied,
}: {
  connectionId: string;
  revision: Revision;
  onMissing: OnMissing;
  canManage: boolean;
  /** The run that applies it was started. */
  onApplied: () => void;
}) {
  const apply = useApplyRevision(connectionId);
  const discard = useDiscardRevision(connectionId);
  const skipped = revision.skipped.noId + revision.skipped.duplicate;
  return (
    <Card>
      <CardHeader title={`New version · ${revision.name}`} />
      <CardBody className="flex min-w-0 flex-col gap-4">
        <p className="text-sm text-fg-muted">
          {pluralize(revision.rows, 'row')} · uploaded {formatDateTime(revision.createdAt)}
          {revision.createdByName ? ` by ${revision.createdByName}` : ''}
          {revision.expiresAt ? ` · expires ${formatDateTime(revision.expiresAt)}` : ''}
        </p>
        {revision.diff ? <DiffSummary diff={revision.diff} onMissing={onMissing} /> : null}
        {skipped > 0 ? (
          <p className="text-sm text-fg-muted">
            {pluralize(skipped, 'row')} skipped: no ID or a repeated one.
          </p>
        ) : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              busy="pulse"
              loading={apply.isPending}
              disabled={discard.isPending}
              iconStart={<Check aria-hidden />}
              onClick={() =>
                apply.mutate(revision.id, {
                  onSuccess: onApplied,
                  onError: (error) => toast.error(error, 'Could not apply'),
                })
              }
            >
              Apply
            </Button>
            <Button
              variant="outline"
              loading={discard.isPending}
              disabled={apply.isPending}
              iconStart={<X aria-hidden />}
              onClick={() =>
                discard.mutate(revision.id, {
                  onError: (error) => toast.error(error, 'Could not discard'),
                })
              }
            >
              Discard
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
