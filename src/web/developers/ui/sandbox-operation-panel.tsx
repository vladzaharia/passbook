import { useEffect, useRef } from 'react';
import '../../../generated/operations-kit.css';
import '../styles/dev-operations.css';
import '../../styles/kit-controls.css';
import '../../styles/kit-motion.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/busy.css';
import '../../ui/art/scenes/cheer.css';
import '../../ui/art/scenes/sorry.css';
import { OperationProgress, useOperation, useOperationActions } from '../../ui/operation/index.ts';
import { doneNoteOf } from './sandbox-done-note.ts';
import type { SandboxOperationProps } from './sandbox-operation-types.ts';

/**
 * One sandbox operation, live: the exact step with its count, every step, Retry on the failed one. `onSucceeded` runs
 * once when it ends well (the page mints the key and moves on), `onGone` when it cannot be read (not yours, or
 * long gone), `onClose` leaves a finished or failed panel.
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
