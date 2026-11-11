import { createFileRoute } from '@tanstack/react-router';
import { OrgsPage } from '../../../admin/orgs/orgs-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/route-search.ts';

export const Route = createFileRoute('/admin/orgs/')({
  search: UNSCOPED_SEARCH,
  validateSearch: (
    raw: Record<string, unknown>,
  ): { q?: string | undefined; new?: '1' | undefined } => ({
    q: typeof raw.q === 'string' && raw.q.trim() ? raw.q.trim().slice(0, 200) : undefined,
    new: raw.new === 1 || raw.new === '1' ? '1' : undefined,
  }),
  component: function OrgsRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <OrgsPage
        search={search}
        onSearch={(next) => void navigate({ search: next, replace: true })}
        openNew={search.new === '1'}
        onOpenNewConsumed={() =>
          void navigate({ search: (prev) => ({ ...prev, new: undefined }), replace: true })
        }
      />
    );
  },
});
