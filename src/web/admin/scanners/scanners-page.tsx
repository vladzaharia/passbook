import { EmptyState, PageHeader } from '@/web/ui/index.ts';

export function ScannersPage() {
  return (
    <>
      <PageHeader title="Scanners" />
      <EmptyState art="phone" title="No scanners yet" />
    </>
  );
}
