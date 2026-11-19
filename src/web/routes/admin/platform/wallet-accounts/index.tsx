import { createFileRoute } from '@tanstack/react-router';
import { PlatformWalletAccountsPage } from '../../../../admin/wallet-accounts/platform-page.tsx';

export const Route = createFileRoute('/admin/platform/wallet-accounts/')({
  component: PlatformWalletAccountsPage,
});
