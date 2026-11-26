import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import '../../../generated/operations-kit.css';
import '../styles/dev-operations.css';
import '../../styles/kit-controls.css';
import '../../styles/kit-motion.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/busy.css';
import '../../ui/art/scenes/cheer.css';
import '../../ui/art/scenes/sorry.css';
import { formatShortDateIn } from '../../lib/format.ts';
import {
  createFetchClient,
  type Operation,
  OperationProgress,
  OperationsProvider,
  trackOperation,
  useOperation,
  useOperationActions,
} from '../../ui/operation/index.ts';
import { OPERATION_STARTED } from '../bench/operation-started.ts';

/** A start's 202: the operation is in the page's cache and the tray, and the sandbox chip starts to ring. */
export function startedOperation(op: Operation): void {
  trackOperation(op);
  window.dispatchEvent(new Event(OPERATION_STARTED));
}

/** One operations client for the page, with the session's write token (the site has no router or query cache). */
export function SandboxOperations({ csrf, children }: { csrf: string; children: ReactNode }) {
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  return <OperationsProvider client={client}>{children}</OperationsProvider>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The line under a finished operation: what a delete left to do, what a reset removed. */
export function doneNoteOf(op: Operation): string | null {
  if (op.kind === 'sandbox.delete' || op.kind === 'sandbox.recreate') {
    const erase = op.steps.find((s) => s.key === 'erase' && s.until !== null);
    return op.kind === 'sandbox.delete' && erase?.until
      ? `Data is erased by ${formatShortDateIn(erase.until)}.`
      : null;
  }
  const ids = op.result?.ids;
  if (op.kind !== 'sandbox.reset' || !ids) return null;
  const n = (key: string) => Number(ids[key] ?? 0);
  const kept =
    n('kept') > 0 ? ` ${plural(n('kept'), 'pass', 'passes')} could not be deleted yet.` : '';
  return `Deleted ${plural(n('passes'), 'pass', 'passes')}, ${plural(n('captures'), 'event')} and ${plural(n('calls'), 'call')}.${kept} ${n('resetsLeft')} ${n('resetsLeft') === 1 ? 'reset' : 'resets'} left today.`;
}

/**
 * One sandbox operation, live: the exact step with its count, every step, Retry on the failed one. `onSucceeded` runs
 * once when it ends well (the page mints the key and moves on), `onGone` when it cannot be read (not yours, or
 * long gone), `onClose` leaves a finished or failed panel.
 */
export function SandboxOperation({
  id,
  framing = 'plain',
  next,
  buddy = true,
  onSucceeded,
  onGone,
  onClose,
}: {
  id: string;
  framing?: 'plain' | 'card';
  /** The kind's next action after Done ("Create sandbox"). */
  next?: { label: string; onClick: () => void };
  buddy?: boolean;
  onSucceeded?: (op: Operation) => void;
  onGone?: () => void;
  onClose?: () => void;
}) {
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
