import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ApiKeysPage } from '../../../../../admin/api-keys/api-keys-page.tsx';
import { orgPath, platformPath } from '../../../../../lib/scope.ts';

export const Route = createFileRoute('/admin/o/$orgId/api-keys/')({
  validateSearch: (raw: Record<string, unknown>) => ({
    new: raw.new === 1 || raw.new === '1' ? ('1' as const) : undefined,
  }),
  component: function ApiKeysRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const go = useNavigate();
    return (
      <ApiKeysPage
        createRequested={search.new === '1'}
        onOrgChange={(orgId) =>
          void go({
            href: orgId ? orgPath(orgId, '/api-keys') : platformPath('/api-keys'),
            replace: true,
          })
        }
        onCreateRequestHandled={() =>
          void navigate({ search: (previous) => ({ ...previous, new: undefined }), replace: true })
        }
      />
    );
  },
});
