import { EmptyState, PageHeader } from '@/web/ui/index.ts';

export function ScanningPage() {
  return (
    <>
      <PageHeader title="Scanning" />
      <EmptyState art="phone" title="No scanners yet" />
    </>
  );
}
