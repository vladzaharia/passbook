import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '../../../admin/api-keys/api-keys-page.tsx';

export const Route = createFileRoute('/admin/api-keys/')({
  validateSearch: (raw: Record<string, unknown>) => ({
    new: raw.new === 1 || raw.new === '1' ? ('1' as const) : undefined,
  }),
  component: function ApiKeysRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <ApiKeysPage
        createRequested={search.new === '1'}
        onOrgChange={(orgId) =>
          void navigate({ search: (previous) => ({ ...previous, orgId }), replace: true })
        }
        onCreateRequestHandled={() =>
          void navigate({ search: (previous) => ({ ...previous, new: undefined }), replace: true })
        }
      />
    );
  },
});
