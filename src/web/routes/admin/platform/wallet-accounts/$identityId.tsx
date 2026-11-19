import { createFileRoute } from '@tanstack/react-router';
import { IdentityDetailPage } from '../../../../admin/identities/identity-detail.tsx';

export const Route = createFileRoute('/admin/platform/wallet-accounts/$identityId')({
  component: function IdentityRoute() {
    const { identityId } = Route.useParams();
    return <IdentityDetailPage identityId={identityId} />;
  },
});
