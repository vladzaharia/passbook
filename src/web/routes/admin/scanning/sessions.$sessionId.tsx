import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { z } from 'zod';

const SessionPage = lazy(() =>
  import('../../../admin/scanning/sessions/session-page.tsx').then((m) => ({
    default: m.ScanningSessionPage,
  })),
);
function SessionRoute() {
  const { sessionId } = Route.useParams();
  const { addDevice, deviceId } = Route.useSearch();
  return (
    <Suspense fallback={<p role="status">Loading session…</p>}>
      <SessionPage sessionId={sessionId} deviceId={deviceId} addDevice={addDevice === '1'} />
    </Suspense>
  );
}
export const Route = createFileRoute('/admin/scanning/sessions/$sessionId')({
  validateSearch: z.object({
    addDevice: z
      .preprocess(
        (value) => (value === 1 || value === '1' ? '1' : undefined),
        z.literal('1').optional(),
      )
      .catch(undefined),
    deviceId: z.string().min(1).max(64).optional().catch(undefined),
  }),
  component: SessionRoute,
});
