import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { SkeletonDetail } from '../../../../../ui/index.ts';

const EventPage = lazy(() =>
  import('../../../../../admin/scanning/event-page.tsx').then((m) => ({ default: m.EventPage })),
);

function EventRoute() {
  return (
    <Suspense fallback={<SkeletonDetail label="Loading event" />}>
      <EventPage eventId={Route.useParams().eventId} />
    </Suspense>
  );
}

export const Route = createFileRoute('/admin/o/$orgId/scanning/events/$eventId')({
  component: EventRoute,
});
