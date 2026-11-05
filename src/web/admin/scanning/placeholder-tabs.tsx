import { EmptyState } from '@/web/ui/index.ts';

/** Events, Staff and Scans fill in with their own tasks; until then each shows its empty state. */
export function EventsTab() {
  return (
    <EmptyState art="passes" title="No events yet" description="Count who's in at the door." />
  );
}

export function StaffTab() {
  return (
    <EmptyState
      art="people"
      title="No staff yet"
      description="Give each person a PIN to see who scanned what."
    />
  );
}

export function ScansTab() {
  return <EmptyState art="activity" title="No scans yet" />;
}
