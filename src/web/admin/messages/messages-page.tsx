import { EmptyState, PageHeader } from '@/web/ui/index.ts';

export function MessagesPage() {
  return (
    <>
      <PageHeader title="Messages" />
      <EmptyState art="envelope" title="No messages yet" />
    </>
  );
}
