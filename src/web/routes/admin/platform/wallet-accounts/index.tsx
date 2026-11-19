import { createFileRoute } from '@tanstack/react-router';
import { IdentitiesPage } from '../../../../admin/identities/identities-page.tsx';

export const Route = createFileRoute('/admin/platform/wallet-accounts/')({
  component: IdentitiesPage,
});
