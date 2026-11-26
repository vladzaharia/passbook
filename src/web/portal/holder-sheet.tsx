import { useEffect } from 'react';
import { type Operation, OperationProgress, useOperation } from '../ui/operation/index.ts';
import { Sheet, SheetContent } from '../ui/sheet.tsx';

/** The sheet: the exact step, every step, and Retry on a failure. */
export default function HolderSheet({
  id,
  restart,
  onClose,
}: {
  id: string;
  restart: (() => void) | undefined;
  onClose: () => void;
}) {
  const { operation, missing } = useOperation(id);
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={operation?.title ?? 'Activity'}>
        {operation ? (
          <div className="p-4">
            <OperationProgress
              operation={retryable(operation, restart)}
              onClose={onClose}
              {...(restart ? { onRetry: restart } : {})}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The panel offers Retry only on an error the server can retry. A holder's cannot (no stop or retry route
 * answers a holder), but the page can start the action again, so it is offered here.
 */
function retryable(op: Operation, restart: (() => void) | undefined): Operation {
  return restart && op.error ? { ...op, error: { ...op.error, retryable: true } } : op;
}
