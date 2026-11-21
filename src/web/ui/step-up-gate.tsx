import { lazy, Suspense } from 'react';

const StepUpDialog = lazy(() =>
  import('./step-up-dialog.tsx').then((m) => ({ default: m.StepUpDialog })),
);

/** The dialog and its store load as a separate chunk, so the entry carries only this wrapper. */
export function StepUpGate() {
  return (
    <Suspense>
      <StepUpDialog />
    </Suspense>
  );
}
