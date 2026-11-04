import { EmptyState } from '@/web/ui/index.ts';

/** The staff scanner. Outside the admin layout: it pairs with a device cookie, not a session. */
export function ScanPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center py-6">
      <EmptyState art="phone" heading title="Scanner" />
    </div>
  );
}
