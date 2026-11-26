import { useEffect } from 'react';
import { Sheet, SheetContent } from '../sheet.tsx';
import { OperationProgress } from './operation-progress.tsx';
import { useOperation } from './use-operation.ts';
import { useOperationActions } from './use-tray.ts';

/**
 * One operation's detail in a right sheet (a bottom-width sheet on a phone): opened from the tray,
 * a toast or an entity chip. It polls the operation itself, so it can open on an id alone.
 */
export function OperationSheet({
  id,
  onClose,
  zone,
  next,
}: {
  id: string | null;
  onClose: () => void;
  zone?: string;
  next?: { label: string; onClick: () => void };
}) {
  const { operation, missing } = useOperation(id);
  // A `?op` that is unknown, or not the person's: the sheet has nothing to show, so it goes.
  useEffect(() => {
    if (id && missing) onClose();
  }, [id, missing, onClose]);
  const { stop, retry, retrying } = useOperationActions();
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={operation?.title ?? 'Activity'}>
        {operation ? (
          <div className="p-4">
            <OperationProgress
              operation={operation}
              zone={zone}
              retrying={retrying}
              onStop={() => stop(operation)}
              onRetry={() => retry(operation)}
              onClose={onClose}
              next={next}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
