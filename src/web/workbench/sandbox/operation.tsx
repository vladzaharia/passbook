import { lazy, Suspense } from 'react';
import type { SandboxOperationProps } from '../../developers/ui/sandbox-operation-types.ts';
import { trackOperation } from '../../ui/operation/store.ts';

/** A start's 202: the operation is in the cache, so the tool pages see it at once. */
export const startedOperation = trackOperation;

// The panel (the operations kit and its art) is a chunk of its own: a page that only starts an operation stays small.
const Panel = lazy(() => import('./operation-panel.tsx'));

/**
 * One sandbox operation, live: the exact step with its count, every step, Retry on the failed one
 * (`onSucceeded`, `onGone` and `onClose` as in the developer site's panel, whose stylesheet is unscoped
 * and would reach the shell, so it is not used here).
 */
export function SandboxOperation(props: SandboxOperationProps) {
  return (
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>
  );
}
