import { ChevronRight } from 'lucide-react';
import { Button, EmptyState } from '@/web/ui/index.ts';

/** A developer org is a Test-only sandbox: the way in is the Developers workbench. */
export function SandboxCard() {
  return (
    <EmptyState
      art="wallet"
      artState="empty"
      mood="happy"
      title="Developer sandbox"
      action={
        <Button asChild variant="outline" iconEnd={<ChevronRight aria-hidden />}>
          <a href="/developers">Open Developers</a>
        </Button>
      }
    />
  );
}
