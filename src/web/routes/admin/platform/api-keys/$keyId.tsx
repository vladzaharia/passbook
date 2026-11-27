import { createFileRoute } from '@tanstack/react-router';
import { KeyDetailPage } from '../../../../admin/api-keys/admin-pages.tsx';

export const Route = createFileRoute('/admin/platform/api-keys/$keyId')({
  component: function KeyRoute() {
    const { keyId } = Route.useParams();
    return <KeyDetailPage keyId={keyId} />;
  },
});
