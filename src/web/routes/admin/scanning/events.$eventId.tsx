import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

const EventPage = lazy(() =>
  import('../../../admin/scanning/event-page.tsx').then((m) => ({ default: m.EventPage })),
);

function EventRoute() {
  return (
    <Suspense fallback={<p role="status">Loading event…</p>}>
      <EventPage eventId={Route.useParams().eventId} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/scanning/events/$eventId')({ component: EventRoute });
