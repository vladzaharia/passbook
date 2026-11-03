import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '../../../admin/settings/settings-page.tsx';
import { UNSCOPED_SEARCH } from '../../../lib/route-search.ts';

export const Route = createFileRoute('/admin/settings/')({
  search: UNSCOPED_SEARCH,
  component: SettingsPage,
});
