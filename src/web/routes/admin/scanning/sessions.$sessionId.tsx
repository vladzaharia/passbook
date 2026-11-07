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
  const { deviceId } = Route.useSearch();
  return (
    <Suspense fallback={<p role="status">Loading session…</p>}>
      <SessionPage sessionId={sessionId} deviceId={deviceId} />
    </Suspense>
  );
}
export const Route = createFileRoute('/admin/scanning/sessions/$sessionId')({
  validateSearch: z.object({ deviceId: z.string().min(1).max(64).optional().catch(undefined) }),
  component: SessionRoute,
});
