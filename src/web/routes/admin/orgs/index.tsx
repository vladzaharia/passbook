import { createFileRoute } from '@tanstack/react-router';
import { OrgsPage } from '../../../admin/orgs/orgs-page.tsx';

export const Route = createFileRoute('/admin/orgs/')({
  validateSearch: (raw: Record<string, unknown>): { q?: string | undefined } => ({
    q: typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim().slice(0, 200) : undefined,
  }),
  component: function OrgsRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <OrgsPage
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});
