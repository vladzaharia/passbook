import { createFileRoute } from '@tanstack/react-router';
import { EventPage } from '../../../admin/scanning/event-page.tsx';

function EventRoute() {
  return <EventPage eventId={Route.useParams().eventId} />;
}

export const Route = createFileRoute('/admin/scanning/events/$eventId')({ component: EventRoute });
