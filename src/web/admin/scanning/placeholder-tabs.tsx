import { EmptyState } from '@/web/ui/index.ts';

export function StaffTab() {
  return (
    <EmptyState
      art="people"
      title="No staff yet"
      description="Give each person a PIN to see who scanned what."
    />
  );
}
