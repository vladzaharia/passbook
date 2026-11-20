import { Link } from '@tanstack/react-router';
import { PageHeader } from '@/web/ui/index.ts';
import { ReceiptsCard } from './receipts-card.tsx';

/** Receipts of the platform's own deletions. An organization's receipts are on its page. */
export function PlatformRetentionPage() {
  return (
    <>
      <PageHeader
        title="Retention"
        description={
          <>
            Windows are in{' '}
            <Link
              to="/admin/platform/settings"
              className="text-accent-fg underline underline-offset-2"
            >
              Settings
            </Link>
            ; holds and an organization's receipts are on its page.
          </>
        }
      />
      <ReceiptsCard scope="platform-pass" orgId="" />
    </>
  );
}
