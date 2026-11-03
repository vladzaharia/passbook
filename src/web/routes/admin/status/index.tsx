import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '../../../admin/status/status-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/org-filter.tsx';

export const Route = createFileRoute('/admin/status/')({
  search: UNSCOPED_SEARCH,
  component: StatusPage,
});
