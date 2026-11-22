import { Link } from '@tanstack/react-router';
import { Button, PageHeader } from '@/web/ui/index.ts';
import { ReceiptsCard } from './receipts-card.tsx';

/** Receipts of the platform's own deletions. An organization's receipts are on its page. */
export function PlatformRetentionPage() {
  return (
    <>
      <PageHeader
        title="Retention"
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/platform/settings">Retention windows</Link>
          </Button>
        }
      />
      <ReceiptsCard scope="platform-pass" orgId="" />
    </>
  );
}
