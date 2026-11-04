import { createFileRoute } from '@tanstack/react-router';
import { InboxPage, parseInboxSearch } from '../../../admin/test-inbox/inbox-page.tsx';

export const Route = createFileRoute('/admin/test-inbox/')({
  validateSearch: parseInboxSearch,
  component: function InboxRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return <InboxPage search={search} onSearch={(next) => void navigate({ search: next })} />;
  },
});
