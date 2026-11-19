import { createFileRoute } from '@tanstack/react-router';
import { OrgWalletAccountsPage } from '../../../../../admin/orgs/org-wallet-accounts-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/wallet-accounts/')({
  component: OrgWalletAccountsPage,
});
