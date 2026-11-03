import { createFileRoute } from '@tanstack/react-router';
import { IdentityDetailPage } from '../../../admin/identities/identity-detail.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/route-search.ts';

export const Route = createFileRoute('/admin/identities/$identityId')({
  search: UNSCOPED_SEARCH,
  component: function IdentityRoute() {
    const { identityId } = Route.useParams();
    return <IdentityDetailPage identityId={identityId} />;
  },
});
