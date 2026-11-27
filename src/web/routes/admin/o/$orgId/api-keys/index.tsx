import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '../../../../../admin/api-keys/admin-pages.tsx';

export const Route = createFileRoute('/admin/o/$orgId/api-keys/')({
  validateSearch: (raw: Record<string, unknown>) => ({
    new: raw.new === 1 || raw.new === '1' ? ('1' as const) : undefined,
  }),
  component: function ApiKeysRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <ApiKeysPage
        createRequested={search.new === '1'}
        onCreateRequestHandled={() =>
          void navigate({ search: (previous) => ({ ...previous, new: undefined }), replace: true })
        }
      />
    );
  },
});
