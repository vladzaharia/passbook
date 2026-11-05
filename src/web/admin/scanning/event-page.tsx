import { PageHeader } from '@/web/ui/index.ts';
import { ScanLink } from './scan-link.tsx';

/** The event page opens with AD.3. Until then it keeps the route and the way back. */
export function EventPage({ eventId }: { eventId: string }) {
  return (
    <PageHeader
      title="Event"
      breadcrumbs={[{ label: 'Scanning', to: '/admin/scanning' }, { label: 'Event' }]}
      actions={<ScanLink event={eventId}>Open scanner</ScanLink>}
    />
  );
}
