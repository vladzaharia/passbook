import { createFileRoute } from '@tanstack/react-router';
import { IdentitiesPage } from '../../../admin/identities/identities-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/route-search.ts';

export const Route = createFileRoute('/admin/identities/')({
  search: UNSCOPED_SEARCH,
  component: IdentitiesPage,
});
