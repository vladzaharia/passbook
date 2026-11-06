import { EmptyState } from '@/web/ui/index.ts';

export function StaffTab() {
  return (
    <EmptyState
      art="people"
      title="Staff sign-in unavailable"
      description="Use scanner names to distinguish entrances."
    />
  );
}
