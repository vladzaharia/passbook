import { useEffect } from 'react';
import { toast } from '../ui/index.ts';
import { type Operation, OperationProgress, useOperation } from '../ui/operation/index.ts';
import { Sheet, SheetContent } from '../ui/sheet.tsx';
import { lostPhone, removePass, requestRefresh, resendPass } from './api.ts';

/** The sheet: the exact step, every step, and Retry on a failure. */
export default function HolderSheet({
  id,
  restart,
  follow,
  onClose,
}: {
  id: string;
  restart: (() => void) | undefined;
  follow: (id: string) => void;
  onClose: () => void;
}) {
  const { operation, missing } = useOperation(id);
  // The page that started it knows its own Retry; a sheet restored from `?op` starts the kind's action again.
  const again = restart ?? (operation ? pageAction(operation, follow) : undefined);
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent title={operation?.title ?? 'Activity'}>
        {operation ? (
          <div className="p-4">
            <OperationProgress
              operation={retryable(operation, again)}
              onClose={onClose}
              {...(again ? { onRetry: again } : {})}
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

/**
 * The page action a kind starts from, run again. A lost phone that failed after the code was replaced sends the
 * pass again instead of replacing the code twice.
 */
export function pageAction(op: Operation, follow: (id: string) => void): (() => void) | undefined {
  const passId = op.target?.type === 'pass' ? op.target.id : null;
  if (!passId) return undefined;
  const replaced = op.error?.step === 'wallets' || op.error?.step === 'mail';
  const start: Record<string, (() => Promise<{ operationId?: string | undefined }>) | undefined> = {
    'holder.refresh': () => requestRefresh(passId),
    'holder.resend': () => resendPass(passId),
    'holder.remove': () => removePass(passId),
    'holder.lost_phone': replaced ? () => resendPass(passId) : () => lostPhone(passId),
  };
  const run = start[op.kind];
  if (!run) return undefined;
  return () =>
    void run().then(
      (res) => res.operationId && follow(res.operationId),
      (error: unknown) => toast.error(error, 'Could not try again'),
    );
}
