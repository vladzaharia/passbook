import { useEffect, useRef } from 'react';
import { doneNoteOf } from '../../developers/ui/sandbox-done-note.ts';
import type { SandboxOperationProps } from '../../developers/ui/sandbox-operation-types.ts';
import { OperationProgress, useOperation, useOperationActions } from '../../ui/operation/index.ts';

/**
 * One sandbox operation, live: the exact step with its count, every step, Retry on the failed one.
 * `onSucceeded` runs once when it ends well, `onGone` when it cannot be read, `onClose` leaves a
 * finished or failed panel. The same panel the developer site draws, without its stylesheet: that one
 * is unscoped and would reach the shell.
 */
export default function SandboxOperationPanel({
  id,
  framing = 'plain',
  next,
  buddy = true,
  onSucceeded,
  onGone,
  onClose,
}: SandboxOperationProps) {
  const { operation, missing } = useOperation(id);
  const { retry, retrying } = useOperationActions();
  const told = useRef<string | null>(null);
  const succeeded = operation?.status === 'succeeded' ? operation : null;
  useEffect(() => {
    if (!succeeded || told.current === succeeded.id) return;
    told.current = succeeded.id;
    onSucceeded?.(succeeded);
  }, [succeeded, onSucceeded]);
  useEffect(() => {
    if (missing) onGone?.();
  }, [missing, onGone]);
  if (!operation) return null;
  const note = doneNoteOf(operation);
  return (
    <OperationProgress
      operation={operation}
      framing={framing}
      buddy={buddy}
      {...(note ? { doneNote: note } : {})}
      {...(next ? { next } : {})}
      {...(onClose ? { onClose } : {})}
      onRetry={() => void retry(operation)}
      retrying={retrying}
    />
  );
}
