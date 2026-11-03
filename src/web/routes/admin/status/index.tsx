import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '../../../admin/status/status-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/route-search.ts';

export const Route = createFileRoute('/admin/status/')({
  search: UNSCOPED_SEARCH,
  component: StatusPage,
});
