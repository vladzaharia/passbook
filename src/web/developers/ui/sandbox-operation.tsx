import { lazy, type ReactNode, Suspense, useMemo } from 'react';
import { createFetchClient, OperationsProvider } from '../../ui/operation/client.ts';
import { trackOperation } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { OPERATION_STARTED } from '../bench/operation-started.ts';

/** A start's 202: the operation is in the page's cache and the tray, and the strip's chip looks again, so it rings at once. */
export function startedOperation(op: Operation): void {
  trackOperation(op);
  window.dispatchEvent(new Event(OPERATION_STARTED));
}

/** One operations client for the page, with the session's write token (the site has no router or query cache). */
export function SandboxOperations({ csrf, children }: { csrf: string; children: ReactNode }) {
  const client = useMemo(() => createFetchClient({ csrf: async () => csrf }), [csrf]);
  return <OperationsProvider client={client}>{children}</OperationsProvider>;
}

export { doneNoteOf } from './sandbox-done-note.ts';

import type { SandboxOperationProps } from './sandbox-operation-types.ts';

// The panel (the operations kit, its art and styles) is a chunk of its own: the pages that only start an operation stay small.
const Panel = lazy(() => import('./sandbox-operation-panel.tsx'));

/**
 * One sandbox operation, live: the exact step with its count, every step, Retry on the failed one. `onSucceeded` runs
 * once when it ends well (the page mints the key and moves on), `onGone` when it cannot be read (not yours, or
 * long gone), `onClose` leaves a finished or failed panel.
 */
export function SandboxOperation(props: SandboxOperationProps) {
  return (
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>
  );
}
