import { createFileRoute } from '@tanstack/react-router';
import { OrgWalletAccountsPage } from '../../../../../admin/wallet-accounts/org-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/wallet-accounts/')({
  component: OrgWalletAccountsPage,
});
