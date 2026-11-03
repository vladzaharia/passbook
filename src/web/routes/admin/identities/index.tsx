import { createFileRoute } from '@tanstack/react-router';
import { IdentitiesPage } from '../../../admin/identities/identities-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/org-filter.tsx';

export const Route = createFileRoute('/admin/identities/')({
  search: UNSCOPED_SEARCH,
  component: IdentitiesPage,
});
