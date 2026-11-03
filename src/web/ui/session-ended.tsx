import { lazy, Suspense } from 'react';
import { useSessionEnded } from '../lib/api.ts';

const SessionEndedDialog = lazy(() =>
  import('./session-ended-dialog.tsx').then((m) => ({ default: m.SessionEndedDialog })),
);

/** The dialog loads only once a session ends: the first load carries none of it. */
export function SessionEnded() {
  return useSessionEnded() ? (
    <Suspense fallback={null}>
      <SessionEndedDialog />
    </Suspense>
  ) : null;
}
